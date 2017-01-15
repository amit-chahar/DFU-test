var noble = require('noble'),
    fs = require('fs'),
    readline = require("readline"),
    crc = require('crc'),
    fileUtils = require('./file_utils'),
    littleEndianUtils = require('./little_endian_utils');

var rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout
});

var dfuTargService = '0000fe5900001000800000805f9b34fb';
var dfuControlpointCharacteristicUuid = '8ec90001f3154f609fb8838830daea50';
var dfuPacketCharacteristicUuid = '8ec90002f3154f609fb8838830daea50';

const CONTROL_OPCODES = {
    CREATE: 0x01,
    SET_PRN: 0x02,
    CALCULATE_CHECKSUM: 0x03,
    EXECUTE: 0x04,
    SELECT: 0x06,
    RESPONSE_CODE: 0x60,
};

const CONTROL_PARAMETERS = {
    COMMAND_OBJECT: 0x01,
    DATA_OBJECT: 0x02,
};


var dfuTargServiceData = null;
var dfuControlpointCharacteristicData = null;
var dfuPacketCharacteristicData = null;

var imageBuf;
var peripheralsData = []

noble.on('stateChange', function (state) {
    if (state === 'poweredOn') {
        console.log('scanning...');
        noble.startScanning();
        get_pps();
    }
    else {
        noble.stopScanning();
    }
});

function get_pps() {
    noble.on('discover', function (peripheral) {
        console.log("Found a peripheral");
        peripheralsData.push(peripheral);
    });

    setTimeout(function () {
        noble.stopScanning();
        if (peripheralsData.length == 0) {
            console.log("No peripherals found.");
            process.exit(0);
        } else {
            console.log("Please select the peripheral no. for DFU:");
            var count = 0;
            for (var i = 0; i < peripheralsData.length; i++) {
                console.log("PP no.: " + i + " Address: " + peripheralsData[i].address);
                count++;
                if (count == peripheralsData.length) {
                    rl.question("Enter your choice: ", function (answer) {
                        if (!isNaN(answer)) {
                            var pp = peripheralsData[parseInt(answer)];
                            unZipFile("test_firmware.zip", pp);
                        }
                    });
                }
            }
        }
    }, 5000);
}

function unZipFile(fileName, peripheral) {
    var result = fileUtils.unZip(fileName);
    if (result) {
        if (result[0].substr(result[0].length - 3, result[0].length) == "dat") {
            doDfu(result[0], result[1], peripheral)
        } else {
            doDfu(result[1], result[0], peripheral)
        }
    } else {
        console.log("Error: unzipping file");
    }
}


function doDfu(datFile, binFile, peripheral) {

    peripheral.connect(function (err) {
        if (err) {
            console.log("Error: connecting peripheral");
            return;
        }
        console.log("Connected to peripheral")
        peripheral.discoverServices(['fe59'], function (err, services) {
            if (err) {
                console.log("Error: discovering services");
                return;
            }
            console.log("Found dfu service");
            services.forEach(function (service) {
                console.log('Found service:', service.uuid);
                dfuTargServiceData = service;
                service.discoverCharacteristics([], function (err, characteristics) {
                    if (err) {
                        console.log("Error: discovering characteristics");
                        return;
                    }
                    characteristics.forEach(function (characteristic) {
                        console.log('Found characteristic:', characteristic.uuid);
                        if (dfuControlpointCharacteristicUuid == characteristic.uuid) {
                            dfuControlpointCharacteristicData = characteristic;
                        }
                        else if (dfuPacketCharacteristicUuid == characteristic.uuid) {
                            dfuPacketCharacteristicData = characteristic;
                        }
                        if (dfuPacketCharacteristicData && dfuControlpointCharacteristicData) {
                            dfuControlpointCharacteristicData.notify(true, function (err) {
                                if (err) {
                                    console.log("Error: enabling notifications");
                                    return;
                                }
                                console.log('Notification on');
                                dfuControlpointCharacteristicData.write(new Buffer([CONTROL_OPCODES.SET_PRN, 0x00, 0x00]), true, function (err) {
                                    if (err) {
                                        console.log('Error: SET_PRN');
                                        return;
                                    }
                                    else {
                                        console.log("Written PRN");
                                        fileUtils.parseBinaryFile(`./tmp/` + datFile)
                                            .then((result) => {
                                                expectedCRC = crc.crc32(result);
                                                console.log(expectedCRC);
                                                sendData(dfuPacketCharacteristicData, result)
                                                    .then(() => {
                                                        dfuControlpointCharacteristicData.write(new Buffer([CONTROL_OPCODES.CALCULATE_CHECKSUM]), true, function (err) {
                                                            if (err) {
                                                                console.log("Error: CALCULATE_CHECKSUM");
                                                                return;
                                                            }
                                                            console.log(".dat File Sent");
                                                            dfuControlpointCharacteristicData.write(new Buffer([CONTROL_OPCODES.EXECUTE]), true, function (err) {
                                                                if (err) {
                                                                    console.log("Error: EXECUTE");
                                                                    return;
                                                                }
                                                                console.log("Execute Cmd in Notification");
                                                                dfuControlpointCharacteristicData.write(new Buffer([CONTROL_OPCODES.SELECT, CONTROL_PARAMETERS.DATA_OBJECT]), true, function (err) {
                                                                    if (err) {
                                                                        console.log("Error: SELECT");
                                                                        return;
                                                                    }
                                                                    console.log("Select Cmd in Notification");
                                                                    fileUtils.parseBinaryFile(`./tmp/` + binFile)
                                                                        .then((result) => {
                                                                            console.log(".bin File parsed");
                                                                            imageBuf = result;
                                                                            console.log(imageBuf.length);
                                                                            dfuControlpointCharacteristicData.write(new Buffer([CONTROL_OPCODES.CREATE, CONTROL_PARAMETERS.DATA_OBJECT, 0x0, 0x10, 0x0, 0x0]), true, function (err) {
                                                                                if (err) {
                                                                                    console.log("Error: sending bin file");
                                                                                    return;
                                                                                }
                                                                                console.log("Create Cmd Sent");
                                                                                sendData(dfuPacketCharacteristicData, imageBuf.slice(0, 0x1000))
                                                                                    .then(() => {
                                                                                        function checkFileStatus() {
                                                                                            expectedCRC = crc.crc32(imageBuf.slice(0, 0x1000));
                                                                                            console.log(expectedCRC);
                                                                                            imageBuf = imageBuf.slice(0x1000);
                                                                                            if (imageBuf.length !== 0) {
                                                                                                sendData(dfuPacketCharacteristicData, imageBuf.slice(0, 0x1000))
                                                                                                    .then(() => {
                                                                                                        checkFileStatus();
                                                                                                    })
                                                                                            }
                                                                                            else {
                                                                                                console.log(".bin File Sent");
                                                                                                console.log("Done Execution");
												console.log("Firmware updated");
												process.exit(0);
                                                                                            }
                                                                                        }

                                                                                        checkFileStatus();
                                                                                    });
                                                                            });
                                                                        });
                                                                });
                                                            });
                                                        });
                                                    });
                                            });
                                    }
                                });
                            });
                        }
                    });
                });
            });
        });
    });
}

function sendData(characteristic, buffer) {
    return new Promise((resolve, reject) => {
        if (buffer.length <= 0) {
            resolve();
        }
        else {
            characteristic.write(littleEndianUtils.littleEndian(buffer.slice(0, 20)), true, function (err) {
                if (err) {
                    console.log('Error: sendData');
                    reject(err);
                }
                else {
                    sendData(characteristic, buffer.slice(20))
                        .then(() => {
                            resolve();
                        })
                }
            });
        }
    });
}
