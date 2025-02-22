/***
 * 
 * Copyright 2019-2021 VMware, Inc.
 * SPDX-License-Identifier: Apache-2.0
 * 
***/


const srsImporter = require("../utils/srsImporter");
const projectDB = require('../db/project-db');
const srsDB = require('../db/srs-db');
const createCsvWriter = require("csv-writer").createObjectCsvWriter;
const CSVArrayWriter = require("csv-writer").createArrayCsvWriter;
const { GENERATESTATUS, PAGINATETEXTLIMIT, PAGINATELIMIT, FILEFORMAT, LABELTYPE, PROJECTTYPE, S3OPERATIONS, FILETYPE, DATASETTYPE, FILEPATH } = require("../config/constant");
const fs = require('fs');
const ObjectId = require("mongodb").ObjectID;
const moment = require('moment');
const { findFrequentlyElementInObject, probabilisticInObject, findFrequentlyElementInArray } = require('../utils/common.utils');
const csv = require('csvtojson');
const dataSetService = require('../services/dataSet-service');
const S3 = require('../utils/s3');
const validator = require("../utils/validator");
const imgImporter = require("../utils/imgImporter");
const logImporter = require("../utils/logImporter");
const { getModelProject } = require("../utils/mongoModel.utils");
const mongoDb = require("../db/mongo.db");
const S3Utils = require('../utils/s3');
const { DataSetModel } = require("../db/db-connect");
const compressing = require('compressing');
const streamifier = require('streamifier');
const readline = require('readline');
const localFileSysService = require('./localFileSys.service');
const _ = require("lodash");
const config = require('../config/config');

async function createProject(req) {

    await validator.checkProjectByconditions({projectName: req.body.pname}, false);

    console.log(`[ FILE ] Service createProject init parameters`);
    let annotators = req.body.assignee;
    annotators = (typeof annotators === 'string'? JSON.parse(annotators):annotators);
    
    let userCompleteCase = [];
    annotators.forEach(item => {
        const inintUser = { user: item };
        userCompleteCase.push(inintUser);
    });
    
    console.log(`[ FILE ] Service ticktes to db`);
    await srsImporter.execute(req, annotators);
    await imgImporter.execute(req, true, annotators);
    await logImporter.execute(req, true, annotators);

    console.log(`[ FILE ] Service save project info to db`);
    return saveProjectInfo(req, userCompleteCase, annotators);
}

async function saveProjectInfo(req, userCompleteCase, annotators){

    
    let selectedColumn = req.body.selectDescription;
    selectedColumn = (typeof selectedColumn === 'string'? JSON.parse(selectedColumn):selectedColumn);
    
    let labels = req.body.labels;
    labels = (typeof labels === 'object'? labels.toString(): labels);

    let totalCase = 0, alFailed = req.body.isMultipleLabel === 'true'? true: false;
    if (req.body.projectType == PROJECTTYPE.IMGAGE) {
        totalCase = req.body.totalRows;
        alFailed = true;
    }


    const project = {
        creator: [req.auth.email],
        createdDate: Date.now(),
        updatedDate: Date.now(),
        projectName: req.body.pname,
        taskInstructions: req.body.taskInstruction,
        totalCase: totalCase,
        userCompleteCase: userCompleteCase,
        maxAnnotation: req.body.maxAnnotations,
        projectCompleteCase: 0,
        categoryList: labels,
        assignmentLogic: req.body.assignmentLogic,
        annotator: annotators,
        dataSource: req.body.fileName,
        selectedDataset: [req.body.selectedDataset],
        selectedColumn: selectedColumn,
        annotationQuestion: req.body.annotationQuestion,
        shareStatus: false,
        shareDescription: '',
        generateInfo: {
            status: GENERATESTATUS.DEFAULT,
        },
        fileSize: req.body.fileSize,
        labelType: req.body.labelType,
        min: (Number.isNaN(+req.body.min) ? 0 : +req.body.min),
        max: (Number.isNaN(+req.body.max) ? 0 : +req.body.max),
        al: {
            estimator: req.body.estimator,
            alFailed: alFailed,
        },
        projectType: req.body.projectType,
        encoder: req.body.encoder,
        isMultipleLabel: req.body.isMultipleLabel === 'true'? true: false,
        regression: req.body.regression === 'true'? true: false,
        isShowFilename: req.body.isShowFilename === 'true'? true: false,
    };
    return await projectDB.saveProject(project);
}

async function generateFileFromDB(id, format, onlyLabelled, user) {

    const start = Date.now();
    console.log(`[ FILE ] Service generateFileFromDB start: ${start}`);
    const mp = await getModelProject({_id: ObjectId(id)});

    const fileName = await prepareCsv(mp, format, onlyLabelled, user);
    console.log(`[ FILE ] Service generateFileFromDB end within:[ ${(Date.now() - start) / 1000}s]`);
    return fileName;
}

async function prepareHeaders(project, format) {
    console.log(`[ FILE ] Service prepareHeaders`);

    let headerArray = [];
    //selected headers
    if (project.projectType == PROJECTTYPE.IMGAGE || project.projectType == PROJECTTYPE.LOG) {
        let param = { id: "fileName", title: "fileName" };
        headerArray.push(param);
    }else{
        await project.selectedColumn.forEach(item => {
            let param = { id: item, title: item };
            headerArray.push(param);
        });
    }
    
    // label info regression project doesn't need
    if (project.labelType != LABELTYPE.NUMERIC) {
        await project.categoryList.split(",").forEach(item => {
            let param = { id: item, title: item };
            headerArray.push(param);
        });
    }

    if (format == FILEFORMAT.TOPLABEL) {
        headerArray.push({ id: "top_label", title: "top_label" });
    } else if (format == FILEFORMAT.PROBABILISTIC) {
        headerArray.push({ id: "probabilistic", title: "probabilistic" });
    }

    //regression project
    if (project.labelType == LABELTYPE.NUMERIC) {
        for (let index = 0; index < project.maxAnnotation; index++) {
            headerArray.push({ id: `annotation_${index + 1}`, title: `annotation_${index + 1}` });
        }
    }

    console.log(`[ FILE ] Service prepareHeaders-end`);
    return headerArray;
}

async function prepareContents(srData, project, format) {

    let cvsData = [];
    for (const srs of srData) {
        //1. standard csv 
        let newCase = {};
        // init lable annotation regression project doesn't need
        let labelCase = {};
        
        if (project.projectType == PROJECTTYPE.IMGAGE) {
            //imageName
            newCase.fileName = srs.originalData.fileName;

            await project.categoryList.split(",").forEach(item => {
                newCase[item] = [];
            });
            
            await srs.userInputs.forEach(async item => {
                const pc = item.problemCategory.value;
                const annLable = pc.rectanglelabels? pc.rectanglelabels[0]: pc.polygonlabels[0];

                await project.categoryList.split(",").forEach((label) => {
                    if (annLable == label) {
                        newCase[label].push(item.problemCategory)
                    }
                });

            });
            // change annotations to a string array 
            await project.categoryList.split(",").forEach(item => {
                newCase[item] = newCase[item][0]? JSON.stringify(newCase[item]):[];
            });
            
        }else if (project.projectType == PROJECTTYPE.NER) {
            
            // init selected data
            await project.selectedColumn.forEach(item => {
                newCase[item] = (srs.originalData)[item];
            });

            await project.categoryList.split(",").forEach(item => {
                newCase[item] = [];
            });
            
            await srs.userInputs.forEach(async item => {
                await item.problemCategory.forEach(async lb =>{
                    await project.categoryList.split(",").forEach((label) => {
                        if (lb.label === label) {
                            newCase[label].push({[lb.text]: [lb.start, lb.end]})
                        }
                    });
                });
            });
            //change annotations to a string array 
            await project.categoryList.split(",").forEach(item => {
                newCase[item] = newCase[item][0]? JSON.stringify(newCase[item]):[];
            });
        }else if(project.projectType == PROJECTTYPE.LOG){
            // init log classification fileName
            newCase.fileName = srs.fileInfo.fileName;

            await project.categoryList.split(",").forEach(item => {
                newCase[item] = [];
            });
            
            await srs.userInputs.forEach(async item => {
                await item.problemCategory.sort((a,b) => {return a.line - b.line}).forEach(async lb =>{
                    await project.categoryList.split(",").forEach((label) => {
                        if (lb.label === label) {
                            const line = lb.line;
                            let data = { [line]: srs.originalData[line] };
                            if (lb.freeText) {
                                data["freeText"] = lb.freeText;
                            }
                            newCase[label].push(data)
                        }
                    });
                });
            });
            //change annotations to a string array 
            await project.categoryList.split(",").forEach(item => {
                newCase[item] = newCase[item][0]? JSON.stringify(newCase[item]):[];
            });
        }else{
            // init selected data
            await project.selectedColumn.forEach(item => {
                newCase[item] = (srs.originalData)[item];
            });

            if (project.labelType != LABELTYPE.NUMERIC) {
                // init label headers
                await project.categoryList.split(",").forEach(item => {
                    newCase[item] = 0;
                    labelCase[item] = 0;
                });
                // calculate labeld case number
                await srs.userInputs.forEach(async item => {
                    await project.categoryList.split(",").forEach((labels) => {
                        if (item.problemCategory === labels) {
                            newCase[labels] += 1;
                            labelCase[labels] += 1;
                        }
                    });
                });
            }
        }

        //2. top lable csv
        if (format == FILEFORMAT.TOPLABEL) {
            const lbnum = await findFrequentlyElementInObject(labelCase);
            newCase.top_label = lbnum ? Object.keys(lbnum)[0] : "N/A";
        //3. probabilistic csv
        } else if (format == FILEFORMAT.PROBABILISTIC) {
            const probab = await probabilisticInObject(labelCase);
            let probablistic = [];
            //to keep lables order
            await project.categoryList.split(",").forEach(label => {
                probablistic.push(probab[label]);
            });
            newCase.probabilistic = `(${probablistic})`;
        }
        //4. regression project
        if (project.labelType == LABELTYPE.NUMERIC) {
            for (let index = 0; index < project.maxAnnotation; index++) {
                if (srs.userInputs[index]) {
                    newCase[`annotation_${index + 1}`] = srs.userInputs[index].problemCategory;
                } else {
                    newCase[`annotation_${index + 1}`] = "";
                }
            }
        }
        
        cvsData.push(newCase);
    }
    return cvsData;
}

async function prepareCsv(mp, format, onlyLabelled, user) {
    console.log(`[ FILE ] Service prepareCsv`);

    let headerArray = await prepareHeaders(mp.project, format);

    const now = moment().format('MMDDYYYYHHmmss');
    const fileName = `Export_${mp.project.dataSource.replace('.csv', "").replace('.zip', "").replace('.tgz', "")}_${now}.csv`;

    const filePath = `./${FILEPATH.DOWNLOAD}/${user}`;
    const filePosition = `${filePath}/${fileName}`
    await localFileSysService.checkFileExistInLocalSys(filePath, true);

    let csvWriterOptions = {
        path: filePosition,
        header: headerArray,
        alwaysQuote: true
    };
    console.log(`[ FILE ] Service prepare csvWriterOptions info`, csvWriterOptions.path);


    let options = { page: 1, limit: mp.project.projectType==PROJECTTYPE.LOG? PAGINATETEXTLIMIT : PAGINATELIMIT };
    let query = { projectName: mp.project.projectName };
    onlyLabelled == 'Yes' ? query.userInputsLength = { $gt: 0 }: query;

    while (true) {
        
        // let result = await srsDB.paginateQuerySrsData(query, options);
        let result = await mongoDb.paginateQuery(mp.model, query, options);
        let cvsData = await prepareContents(result.docs, mp.project, format);

        let csvWriter = await createCsvWriter(csvWriterOptions);
        await csvWriter.writeRecords(cvsData);

        if (result.hasNextPage) {
            csvWriterOptions.append = true;
            options.page = result.nextPage;
        } else {
            console.log(`[ FILE ] Service [Generate-End-] totalCase= ${result.totalDocs} lastPage= ${result.totalPages}`);
            break;
        }
    }
    return fileName
}

async function updateGenerateStatus(id, status, file, messageId, format, onlyLabelled) {

    const condition = { _id: id };
    let update = {
        $set: {
            "generateInfo.status": status,
            "generateInfo.updateTime": Date.now()
        }
    };
    if (messageId) {
        update.$set["generateInfo.messageId"] = messageId;
        update.$set["generateInfo.startTime"] = Date.now();
    }
    if (file) {
        update.$set["generateInfo.file"] = file;
    }
    if (format) {
        update.$set["generateInfo.format"] = format;
    }
    if (onlyLabelled) {
        update.$set["generateInfo.onlyLabelled"] = onlyLabelled;
    }
    const optional = { new: true };
    console.error(`[ FILE ] Service update file generate status`);
    return await projectDB.findUpdateProject(condition, update, optional);
}

async function queryFileForDownlad(req) {

    console.log(`[ FILE ] Service query file generate info`);
    const data = await projectDB.queryProjectById(ObjectId(req.query.pid));
    data._doc.generateInfo.labelType = data.labelType ? data.labelType : LABELTYPE.TEXT;
    let response = data.generateInfo;
    let originalDataSets = [];
    const generatedFile = data.generateInfo.file;

    if (config.useLocalFileSys) {

        if (data.projectType == PROJECTTYPE.LOG) {
            for (const dataset of data.selectedDataset) {
                const ds = await mongoDb.findOneByConditions(DataSetModel, {dataSetName: dataset}, 'location');
                originalDataSets.push(ds.location);
            }
        }

    }else{
        const S3 = await S3Utils.s3Client();
    
        if (generatedFile) {//data.generateInfo alway not null
            console.log(`[ FILE ] Service found file: ${generatedFile}`);
            const signedUrl = await S3Utils.signedUrlByS3(S3OPERATIONS.GETOBJECT, generatedFile, S3);
            response.file = Buffer.from(signedUrl).toString("base64");
        }
        if (data.projectType == PROJECTTYPE.LOG) {
            for (const dataset of data.selectedDataset) {
                const ds = await mongoDb.findOneByConditions(DataSetModel, {dataSetName: dataset}, 'location');
                const signedUrl = await S3Utils.signedUrlByS3(S3OPERATIONS.GETOBJECT, ds.location, S3);
                originalDataSets.push(signedUrl)
            }
        }
    }
    
    data._doc.generateInfo.originalDataSets = originalDataSets;
    
    return response;
}

async function arrayWriteTempCSVFile(filePosition, headerArray, csvData) {
    console.error(`[ FILE ] Service arrayWriteTempCSVFile ${filePosition}`);
    let csvWriterOptions = {
        path: filePosition,
        header: headerArray,
        alwaysQuote: true
    };
    const csvWriter = await CSVArrayWriter(csvWriterOptions);
    await csvWriter.writeRecords(csvData);
}

async function getFileSizeInBytes(file) {
    const stats = fs.statSync(file)
    const fileSizeInBytes = stats["size"]
    console.error(`[ FILE ] Service getFileSizeInBytes file:${file} fileSizeInBytes:${fileSizeInBytes}`);
    return fileSizeInBytes
}

async function generateAllSr(projectName, filePosition) {

    let csvWriterOptions = {
        path: filePosition,
        header: ['id', 'text', 'label'],
        alwaysQuote: true
    };
    console.log(`[ FILE ] Service prepare generateAllSr`, csvWriterOptions.path);

    let options = { page: 1, limit: PAGINATELIMIT };
    while (true) {
        let result = await srsDB.paginateQuerySrsData({ projectName: projectName }, options);
        let cvsData = await csvContentsSrs(result);

        const csvWriter = await CSVArrayWriter(csvWriterOptions);
        await csvWriter.writeRecords(cvsData);
        if (result.hasNextPage) {
            csvWriterOptions.append = true;
            options.page = result.nextPage;
        } else {
            console.log(`[ FILE ] Service [Generate-End-] totalCase= ${result.totalDocs} lastPage= ${result.totalPages}`);
            break;
        }
    }
    return projectName;
}

async function csvContentsSrs(result) {
    let cvsData = [];
    for (let i = 0; i < result.docs.length; i++) {
        //csv content
        const content = [];

        content.push(result.docs[i]._id);//id
        content.push(Object.values(result.docs[i].originalData))//text

        const labels = [];
        result.docs[i].userInputs.forEach(input => {
            labels.push(input.problemCategory);
        });
        const label = await findFrequentlyElementInArray(labels)
        content.push(label);//labels

        cvsData.push(content);
    }
    return cvsData;
}

async function uploadFile(req) {

    await validator.checkDataSet({dataSetName: req.body.dsname}, false);
    
    const fileSplit = req.file.originalname.toLowerCase().split(".");
    const fileType = fileSplit[fileSplit.length-1];
    
    if (![FILETYPE.CSV, FILETYPE.ZIP, FILETYPE.TGZ].includes(fileType)) {
        return {CODE: 3001, MSG: "FILE FORMAT NOT SUPPORTED"};
    }
    
    const fileKey = `upload/${req.auth.email}/${Date.now()}_${req.file.originalname}`;
    const file = await S3.uploadObject(fileKey, req.file.buffer);

    const datasetInfo = {
        body:{
            dsname: req.body.dsname,
            fileKey: fileKey,
            fileName: req.file.originalname,
            fileSize: req.file.size,
            location: file.Key
        },
        auth:{email: req.auth.email}
    }

    let filestream = req.file.buffer, totalRows = 0, topReview;
    
    if (FILETYPE.CSV == fileType) {
        let header = [], topRows = [];
        let headerRule = { noheader: true };
        req.body.hasHeader == 'no' ? null: headerRule.noheader=false;

        await csv(headerRule).fromString(filestream.toString()).subscribe((row,i) => {
            if (i < 5) {
                if (i==0) header = Object.keys(row);
                topRows.push(Object.values(row));
            }else{
                filestream = null;
            }
        });
        topReview = { header: header, topRows: topRows };

        datasetInfo.body.format = FILETYPE.CSV;
        datasetInfo.body.hasHeader = req.body.hasHeader;
        datasetInfo.body.topReview = topReview;

        console.error("[ FILE ] [ FINISH ] Service swagger upload csv done ->");
        await dataSetService.saveDataSetInfo(datasetInfo);

    }else if ([FILETYPE.ZIP, FILETYPE.TGZ].includes(fileType)) {
        topReview = [];
        
        if (fileType  == FILETYPE.ZIP) {
            uncompressStream = new compressing.zip.UncompressStream();
        }else if (fileType == FILETYPE.TGZ) {
            uncompressStream = new compressing.tgz.UncompressStream();
        }
        
        streamifier.createReadStream(filestream).pipe(uncompressStream).on('entry', (header, stream, next) => {
            stream.on('end', next);
    
            const nameSplit = header.name.toLowerCase().split("/");
            const name = nameSplit[nameSplit.length-1]
            const fileSplit = header.name.toLowerCase().split(".");
            const fileType = fileSplit[fileSplit.length-1];
    
            if (header.type === 'file' && (header.size || header.yauzl.uncompressedSize) && !name.startsWith("._") && fileType == DATASETTYPE.LOG) {
                if (totalRows <= 2) {
                    let index = 0, textLines = "";
                    let readInterface = readline.createInterface({ input: stream });
                    readInterface.on('line', (line) => {
                        if (index >= 5) {
                            readInterface.emit('close');
                        }else{
                            if (line && line.trim() && validator.isASCII(line)) {
                                index ++;
                                textLines += line.trim() + "\n";
                            }
                        }
                    }).on('close', () => {
                        if (Object.keys(textLines).length) {
                            topReview.push({
                                fileSize: header.size? header.size: header.yauzl.uncompressedSize,
                                fileName: header.name,
                                fileContent: textLines
                            });
                        }
                        readInterface.removeAllListeners();
                    });
                }
                totalRows++;
            }
            stream.resume();
        }).on('error',err => {
            console.error("[ FILE ] [ ERROR ] Service swagger upload datasets error ->", err);
            throw {CODE: 500, MSG: "SAVE DATASETS ERROR"}
        }).on('finish', async () => {
            datasetInfo.body.format = DATASETTYPE.LOG;
            datasetInfo.body.topReview = topReview;
            datasetInfo.body.totalRows = totalRows;
            
            console.error("[ FILE ] [ FINISH ] Service swagger upload uncompressStream done ->");
            await dataSetService.saveDataSetInfo(datasetInfo);
        });
    }
    return {CODE: 200, MSG: "OK"};

}

async function setData(req) {

    const label = req.body.label;
    const columns = req.body.columns;
    const location = req.body.location;
    const noheader = req.body.hasHeader == "yes"? false: true;
    
    let numberLabel = true;
    let lableType = "string";
    let labels = [];
    let totalCase = 0;
    let perLbExLmt = false;
    let totLbExLmt = false;
    let removedCase = 0;

    if (columns.includes(label)) {
        throw {CODE: 4008, MSG: "LABEL SHOULD NOT CONTAINS IN COLUMNS"};
    }

    const headerRule = {
        noheader: false,
        fork: true,
        flatKeys: true,
        checkType:true,
        noheader: noheader
    }
    let readStream = await localFileSysService.readFileFromLocalSys(location);
    await csv(headerRule).fromStream(readStream).subscribe(async (oneData, index) =>{
        let lable = oneData[label];
        if (lable) {
            if (typeof lable != 'number') {
                numberLabel = false;
            }
            if (!numberLabel && lable.length > 50) {
                perLbExLmt = true;
                lable = oneData[label].toString().substr(0, 50);
            }
            labels.push(lable);
        }
        

        let select="";
        await columns.forEach( item =>{ select += oneData[item]});
        let selectedData = select.replace(new RegExp(',', 'g'),'').trim();
        if(selectedData && validator.isASCII(selectedData)){
            totalCase += 1;
        }else{
            removedCase += 1;
        }
        if (!numberLabel && index > 50 && _.uniq(labels).length > 50) {
            readStream.emit('end');
            totLbExLmt = true;
        }

    },(err)=>{
        console.error("[ FILE ] [ ERROR ] Service handle set-data", err);
        throw{CODE: 500, MSG: "HANDLE DATA ERROR"}
    },()=>{
        if (totLbExLmt) {
            labels = [];
            totalCase = 0;
            removedCase = 0;
        }
    });
    
    labels = _.uniq(labels);
    
    if (labels.length && numberLabel) {
        lableType = "number";
        const max = _.max(labels);
        const min = _.min(labels);
        labels = [];
        labels.push(min);
        labels.push(max);
    }

    return {
        perLbExLmt: perLbExLmt, 
        totLbExLmt: totLbExLmt, 
        totalCase:totalCase, 
        removedCase: removedCase, 
        lableType: lableType, 
        labels: labels
    };
}

module.exports = {
    createProject,
    generateFileFromDB,
    arrayWriteTempCSVFile,
    updateGenerateStatus,
    queryFileForDownlad,
    getFileSizeInBytes,
    prepareHeaders,
    prepareCsv,
    generateAllSr,
    csvContentsSrs,
    saveProjectInfo,
    uploadFile,
    setData,
}



