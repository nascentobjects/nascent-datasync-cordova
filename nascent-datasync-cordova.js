/*
 * @author Andrew Robberts <andrew@nascentobjects.com>
 * @copyright 2015-2016 Nascent Objects Inc. All rights reserved.
 */
var bluetoothle;
function NascentDataSync(options) {
    EventEmitter.call(this);

    if (!('id' in options)) {
        throw 'An id must be given';
    }

    this.verbose = false;
    if (options.verbose) {
        this.verbose = true;
    }

    this.id = options.id;
    var ids = this.id.split('.');
    this.DataFlagChunkStart = 'S';
    this.DataFlagChunkEnd = 'E';
    this.DataFlagChunkMiddle = 'M';
    this.DataFlagChunkFull = 'F';
    this.NascentDataSyncCommandCharacteristicUUID = 'c50dc35b-9a1b-40c2-bc97-96ee7254579c';
    this.serviceUUID = '686c3dbf-2f84-4eb8-8e62-0c12fc534f7c';
    this.connectedAddress = null;
    this.pendingConnectSuccessCbs = [];
    this.pendingConnectErrorCbs = [];
    this.pendingChunks = [];
    this.pendingSubscribeData = '';

    var self = this;
    this.whenConnected(function(result) {
        self.log('CONNECTED');
    }, function(err, stage) {
        self.log('ERROR');
    });
}

NascentDataSync.prototype = Object.create(EventEmitter.prototype);
NascentDataSync.prototype.constructor = NascentDataSync;

NascentDataSync.prototype.log = function(msg) {
    if (this.verbose) {
        console.log(msg);
    }
};

NascentDataSync.prototype.whenConnected = function(successCb, errCb) {
    var self = this;

    function deferCbs() {
        if (successCb) {
            self.pendingConnectSuccessCbs.push(successCb);
        }
        if (errCb) {
            self.pendingConnectErrorCbs.push(errCb);
        }
    }

    function initialize(successCb, errCb) {
        self.initializing = true;
        self.log('Initializing');
        bluetoothle.initialize(function(result) {
            startScan(successCb, deferCbs);
        }, function(err) {
            self.initializing = false;
            self.log('Initialize err: ' + JSON.stringify(err));
            if (errCb) {
                errCb(err, 'initialize');
            }
        });
    }

    function startScan(successCb, errCb) {
        self.log('Starting Scan on ' +  self.serviceUUID );
        bluetoothle.startScan(function scanSuccess(result) {
            self.log('Scan Result: ' + JSON.stringify(result));
                    
            if (result.status === 'scanResult') {
                console.log('Connecting to ' + result.name);
                connectDevice(result.address, successCb, errCb);
            }
        }, function scanError(err) {
            self.initializing = false;
            self.log('Start Scan Error: ' + JSON.stringify(err));
            if (errCb) {
                errCb(err, 'startScan');
            }
        }, {
            serviceUuids: [ self.serviceUUID ]
        });
    }

    function connectDevice(address, successCb, errCb) {
        bluetoothle.stopScan();
        setTimeout(function() {
            bluetoothle.connect(function(result) {
                self.log('Connect Status: ' + result.status);
                if (result.status === 'connected') {
                    self.log('Connect Result: ' + JSON.stringify(result));
                    discoverDevice(address, successCb, errCb);
                } else if (result.status === 'disconnected' && result.address === self.connectedAddress) {
                    self.emit('disconnect');
                    self.log('Disconnected on connected address.  Try reconnecting');
                    self.whenConnected(function() {
                        self.log('Reconnected after disconnect');
                    });
                }
            }, function(err) {
                self.initializing = false;
                self.log('Connect Error: ' + JSON.stringify(err));
                reconnectDevice(address, successCb, errCb);
            }, {
                address: address
            });
        }, 1000);
    }

    function reconnectDevice(address, successCb, errCb) {
        if (self.connectedAddress) {
            self.log('Reconnect: Have Connected Address');
            // seems like we managed to connect to another device successfully
            return;
        }
        function reconnect() {
            setTimeout(function() {
                self.log('Reconnecting: ' + address);
                bluetoothle.reconnect(function(result) {
                    self.log('Reconnect Status: ' + result.status);
                    if (result.status === 'connected') {
                        self.log('Reconnect result: ' + JSON.stringify(result));
                        discoverDevice(address, successCb, errCb);
                    }
                }, function(err) {
                    self.log('Reconnect Error: ' + JSON.stringify(err));
                    reconnectDevice(address, successCb, errCb);
                }, {
                    address: address
                });
            }, 100);
        }

        bluetoothle.disconnect(function(result) {
            reconnect();
        }, function(err) {
            reconnect();
        }, {
            address: address
        });

    }

    function subscribeDevice(address, successCb, errCb) {
        self.log('SUBSCRIBING: ' + address);
        bluetoothle.subscribe(function(result) {
            if (result.status === 'subscribed') {
                self.log('Successfully subscribed');
                self.log(result);
                
                self.emit('connect');
                bluetoothle.stopScan();
                self.connectedAddress = result.address;
                self.initializing = false;
                if (successCb) {
                    successCb(result);
                }
            } else if (result.status === 'subscribedResult') {
                var v = bluetoothle.bytesToString(bluetoothle.encodedStringToBytes(result.value));
                self.log('Received: ' + v);
                switch (v[0]) {
                    case self.DataFlagChunkStart:
                        self.pendingSubscribeData = v.slice(1);
                        break;
                    case self.DataFlagChunkMiddle:
                        self.pendingSubscribeData += v.slice(1);
                        break;
                    case self.DataFlagChunkEnd:
                        self.pendingSubscribeData += v.slice(1);
                        self.receivedEventData(self.pendingSubscribeData);
                        self.pendingSubscribeData = '';
                        break;
                    case self.DataFlagChunkFull:
                        self.pendingSubscribeData = v.slice(1);
                        self.receivedEventData(self.pendingSubscribeData);
                        self.pendingSubscribeData = '';
                        break;
                }
            }
        }, function(err) {
            self.initializing = false;
            if (errCb) {
                errCb(err, 'subscribe');
            }
        }, {
            address: address,
            serviceUuid: self.serviceUUID,
            characteristicUuid: self.NascentDataSyncCommandCharacteristicUUID,
            isNotification: true
        });
    }

    function discoverDevice(address, successCb, errCb) {
        setTimeout(function() {
            self.log('Discovering: ' + address);
            bluetoothle.discover(function(result) {
                var found = false;
                for (var a=0; a<result.services.length; ++a) {
                    if (result.services[a].serviceUuid === self.serviceUUID) {
                        found = true;
                        break;
                    } else {
                        self.log(result.services[a].serviceUuid + ' not ' + self.serviceUUID);
                    } 
                }
                if (found) {
                    self.log('Connected');
                    subscribeDevice(address, successCb, errCb);
                }
            }, function(err) {
                self.initializing = false;
                self.log('Discover error: ' + JSON.stringify(err));
                if (errCb) {
                    errCb(err, 'discover');
                }
            }, {
                address: address
            });
        }, 1500);
    }

    function success(result) {
        self.log('BLE SUCCESS');
        var a;

        successCb(result);

        for (a=0; a<self.pendingConnectSuccessCbs.length; ++a) {
            self.pendingConnectSuccessCbs[a](result);
        }

        self.pendingConnectSuccessCbs = [];
        self.pendingConnectErrorCbs = [];
    }

    function fail(err, stage) {
        self.log('Error in ' + stage + ': ' + JSON.stringify(err));
        var a;

        errCb(err, stage);

        for (a=0; a<self.pendingConnectErrorCbs.length; ++a) {
            self.pendingConnectErrorCbs[a](err, stage);
        }

        self.pendingConnectSuccessCbs = [];
        self.pendingConnectErrorCbs = [];
    }

    function tryInitialize() {
        if (self.initializing) {
            return;
        }
        self.initializing = true;
        bluetoothle.isInitialized(function(result) {
            if (result.isInitialized) {
                bluetoothle.isScanning(function(result) {
                    if (result.isScanning) {
                        self.log('Already initialized and scanning.  Just wait for other result');
                        deferCbs();
                    } else {
                        self.log('Already initialized but will start scanning');
                        startScan(success, deferCbs);
                    }
                });
            } else {
                self.log('Not initialized.  Will do so');
                initialize(success, fail)
            } 
        });
    }

    if (!self.connectedAddress) {
        tryInitialize();
    } else {
        bluetoothle.isConnected(function(result) {
            if (result.isConnected) {
                successCb({
                    address: self.connectedAddress
                });
            } else {
                delete self.connectedAddress;
                tryInitialize();
            }
        }, function(err) {
            delete self.connectedAddress;
            tryInitialize();
        }, {
            address: self.connectedAddress
        });
    }
};

NascentDataSync.prototype.receivedEventData = function(json) {
    var self = this;
    try {
        var obj = JSON.parse(json);
        this.emit(obj.c, obj.a);
    } catch (e) {
        console.log('nascent-datasync\tThrew out malformed json data packet: ' + json, e);
    }
};

NascentDataSync.prototype.clearEventQueue = function() {
    // WARNING: only do this if you suspect something is going wrong and need to make sure you're on a clean slate.
    this.pendingChunks = [];
    this.processingSendChunks = false;
};

NascentDataSync.prototype.sendEvent = function(eventName, args) {
    var self = this;
    this.whenConnected(function(result) {
        var json;

        if (typeof args != 'undefined') {
            json = '{"c":"' + eventName + '","a":' + JSON.stringify(args) + '}';
        } else {
            json = '{"c":"' + eventName + '"}';
        }

        var flag;
        var data;
        for (var a=0; a<json.length; a+=19) {
            if (a === 0 && a+19 >= json.length) {
                flag = self.DataFlagChunkFull;
            } else if (a+19 >= json.length) {
                flag = self.DataFlagChunkEnd;
            } else if (a === 0) {
                flag = self.DataFlagChunkStart;
            } else {
                flag = self.DataFlagChunkMiddle;
            }
            var data = flag + json.slice(a, a+19);
            self.pendingChunks.push(data);
        }

        function processNextChunk() {
            if (self.pendingChunks.length === 0) {
                self.processingSendChunks = false;
                return;
            }

            if (self.pendingSubscribeData !== '') {
                setTimeout(processNextChunk, 100);
                return;
            }

            var chunk = self.pendingChunks[0];
            self.pendingChunks = self.pendingChunks.slice(1);
            self.log('nascent-datasync\tSending: ' + chunk);
            var v = bluetoothle.bytesToEncodedString(bluetoothle.stringToBytes(chunk));
            bluetoothle.write(function(result) {
                setTimeout(function() {
                    processNextChunk();
                }, 50);
            }, function(err) {
                self.log('Write Error: ' + JSON.stringify(err));
                throw err;
            }, {
                address: self.connectedAddress,
                value: v,
                serviceUuid: self.serviceUUID,
                characteristicUuid: self.NascentDataSyncCommandCharacteristicUUID
            });
        }

        if (!self.processingSendChunks) {
            self.processingSendChunks = true;
            processNextChunk();
        }
    });
};

