/*
Copyright 2019-2021 VMware, Inc.
SPDX-License-Identifier: Apache-2.0
*/
// Protractor configuration file, see link for more information
// https://github.com/angular/protractor/blob/master/lib/config.ts

const { SpecReporter } = require('jasmine-spec-reporter');
let AllureReporter = require('jasmine-allure-reporter');
let HtmlReporter = require('protractor-beautiful-reporter');
const fs = require('fs');
const nycOutput = '.nyc_output';

var conf = {
    my_specs: [
        // './annotate-project-spec copy.ts',
    ],

    ci_specs: [
        // './features/upload-new-dataset-spec.ts',
        // './features/delete-datasets-spec.ts',
        // './features/creat-text-project-spec.ts',
        // './features/annotate-project-buttons-spec.ts',
        // './features/edit-project-spec.ts',
        // './features/annotate-project-dropdown-spec.ts',
        // './features/project-preview-detail-spec.ts',
        // './features/delete-projects-spec.ts',
        // './features/creat-text-multiple-project-spec.ts',
        // './features/annotate-project-multiple-spec.ts',
        // './features/creat-tabular-numeric-project-spec.ts',
        // './features/annotate-project-tabular-numeric-spec.ts',
        // './features/creat-ner-labels-existing-project-spec.ts',
        // './features/annotate-project-ner-labels-existing-spec.ts',
        // './features/creat-log-project-spec.ts',
        // './features/annotate-project-log-spec.ts',
        // './features/creat-image-project-spec.ts',
        // './features/annotate-project-image-spec.ts',
    ],

    specsConst: [
        // './general/login-spec.ts',
        './general/sign-up-external-spec.ts',
        './general/login-external-spec.ts',
    ],

    specsAll: [],
}

exports.config = {
    allScriptsTimeout: 20000,//first page loading time
    // specs: conf.specsConst.concat(conf.my_specs),
    specs: conf.specsConst.concat(conf.ci_specs),
    // specs: conf.specsConst,
    capabilities: {
        'browserName': 'chrome',
        chromeOptions: {
            args: [
                'disable-dev-shm-usage',
                'window-size=1280,1024',
                'ignore-certificate-errors',
                'ignore-ssl-errors',
                'no-sandbox',
                'headless',
            ],
            prefs: {
                download: {
                    'prompt_for_download': false,
                    'directory_upgrade': true,
                    'default_directory': process.cwd() + '\/doc\/download'
                }
            }
        }
    },
    directConnect: true,
    baseUrl: 'http://localhost:4200',
    framework: 'jasmine',
    jasmineNodeOpts: {
        showColors: true,
        defaultTimeoutInterval: 100000,
        print: function () { }
    },
    async beforeLaunch() {
        await setup();
    },
    onPrepare() {
        require('ts-node').register({
            project: process.cwd() + '\/tsconfig.e2e.json'

        });
        // wait ng serve complete before e2e test start
        browser.sleep(15000);
        jasmine.getEnv().addReporter(new SpecReporter({ spec: { displayStacktrace: true }, summary: { displayDuration: true } }));
        // jasmine.getEnv().addReporter(
        //     new Jasmine2HtmlReporter({
        //         savePath: process.cwd() + '\/doc\/reporter',
        //         screenshotsFolder: 'images',
        //         takeScreenshots: true,
        //         takeScreenshotsOnlyOnFailures: true,
        //         cleanDestination: true
        //     })
        // );
        if (!fs.existsSync(nycOutput)) {
            fs.mkdirSync(nycOutput);
        }
        afterEach(async function () {
            await browser
                .executeScript('return JSON.stringify(window.__coverage__);')
                .then(function (coverage) {
                    if (coverage) {
                        const report = coverage.split('webpack://').join('root');
                        require('fs').writeFile(
                            process.cwd() + '\/' + nycOutput + `\/coverage-${new Date().getTime()}.json`,
                            report,
                            function (err) {
                                if (err) {
                                    return console.log(err);
                                }
                                console.log('Coverage file extracted from server and saved to .nyc_output');
                            },
                        );
                    }
                });
        });
        // generate allure report
        jasmine.getEnv().addReporter(
            new AllureReporter({
                resultsDir: process.cwd() + '\/allure-results',
            }),
        );
        // generate beautiful report
        jasmine.getEnv().addReporter(
            new HtmlReporter({
                baseDirectory: process.cwd() + '\/allure-results\/beautifulReport',
            }).getJasmine2Reporter(),
        );
        // attach screenshot to allure report for failed cases
        const originalAddExpectationResult = jasmine.Spec.prototype.addExpectationResult;
        jasmine.Spec.prototype.addExpectationResult = function () {
            if (!arguments[0]) {
                browser.takeScreenshot().then(png => {
                    allure.createAttachment(
                        'Screenshot',
                        () => {
                            return new Buffer(png, 'base64');
                        },
                        'image/png',
                    )();
                });
            }
            return originalAddExpectationResult.apply(this, arguments);
        };
    },
};
const { exec } = require('child_process');
const sleep = ms => {
    return new Promise(resolve => setTimeout(resolve, ms));
};

const setup = () => {
    return new Promise(async (resolve, reject) => {
        let loopCount = 5;
        let flag = true;
        while (flag) {
            try {
                const result = await new Promise(async (resolve2, reject) => {
                    await setTimeout(() => {
                        exec('forever list', async (err, stdout, stderr) => {
                            if (err) {
                                console.log(err);
                                return;
                            }
                            let out = `${stdout}`;
                            let reg = 'uid';
                            if (out.includes(reg)) {
                                await sleep(8000);
                                console.log('\x1B[32m%s\x1b[0m', 'test localhost service is started successfully');
                                console.log(out);
                                resolve2(true);
                            } else if (loopCount > 0) {
                                console.log(
                                    '\x1b[33m%s\x1b[0m',
                                    'test localhost sevice is not started,will retry again',
                                );
                                loopCount--;
                                console.log(out);
                            } else {
                                console.log(
                                    '\x1b[31m%s\x1b[0m',
                                    'kill starting test processs directlly due to failure of starting test localhost service',
                                );
                                process.exit(1);
                            }
                        });
                    }, 5000);
                });
                if (result) {
                    flag = false;
                    resolve(true);
                }
            } catch (error) { }
        }
    });
};



