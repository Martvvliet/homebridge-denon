const fs = require('fs');
const request = require('request');
const parseString = require('xml2js').parseString;

let Service;
let Characteristic;

module.exports = function(homebridge) {
	Service = homebridge.hap.Service;
	Characteristic = homebridge.hap.Characteristic;
	homebridge.registerAccessory('hombridge-denon-heos', 'DenonAVR', denonClient);
};


class denonClient {
	constructor(log, config, api) {
		this.log = log;
		this.port = 3000;

		// configuration
		this.name = config['name'] || 'Denon Receiver';
		this.ip = config['ip'];
		
		this.pollingInterval = config['pollInterval'] || 5;
		this.pollingInterval = this.pollingInterval * 1000;

		this.isTvService = config['tvService'];
		if (this.isTvService === undefined) {
			this.log.debug('TV Service undefined -> false');
			this.isTvService = false;
		}

		this.volumeControl = config['volumeControlBulb'];
		if (this.volumeControl === undefined) {
			this.volumeControl = false;
		}
		this.volumeLimit = config['volumeLimit'];
		if (this.volumeLimit === undefined || isNaN(this.volumeLimit) || this.volumeLimit < 0) {
			this.volumeLimit = 100;
		}

		this.inputs = config['inputs'];

		/* Setup settings button and info button */
		this.infoButton = 'MNINF';
		this.menuButton = 'MNMEN ON';

		this.switchInfoMenu = config['switchInfoMenu'];
		if (this.switchInfoMenu === true) {
			let tempInfo = this.infoButton;
			let tempMenu = this.menuButton;
			this.infoButton = tempMenu;
			this.menuButton = tempInfo;
		}

		/* setup variables */
		this.enabledServices = [];
		this.connected = false;
		this.checkAliveInterval = null;
		
		/* Legacy variables */
		this.task_is_running = false;
		this.requiredInput = config['requiredInput'] || false;
		this.pollInputAll = config['pollInputAll'] || false;

		this.manufacturer = 'Denon';
		this.modelName = config['model'] || 'homebridge-denon-heos';
		this.serialNumber = 'MVV123';
		this.firmwareRevision = '0.0';

		/* start the polling */
		if (!this.checkAliveInterval) {
			if (this.isTvService) {
				this.checkAliveInterval = setInterval(this.checkTVState.bind(this, this.updateTvStatus.bind(this)), this.pollingInterval);
			} else {
				/* Start the polling loop. It will be started after a random interval between 0 and 15 seconds to make sure we don't poll all switches at the same time. */
				this.checkAliveInterval = setInterval(this.pollForUpdates.bind(this), this.pollingInterval);
			}
		}

		/* the services */
		this.retrieveDenonInformation();

		// choose between new (tv integration) or old (legacy) services, in legacy mode the TV will appear as a Switch
		if (this.isTvService) {
			this.setupTvService();
		} else {
			this.setupLegacyService();
		}
	}

	/*****************************************
	* Start of Setup services
	****************************************/
	retrieveDenonInformation() {
		this.log.debug('retrieveDenonInformation');

		var that = this;
		request('http://' + this.ip + ':60006/upnp/desc/aios_device/aios_device.xml', function(error, response, body) {
			if(error) {
				that.log.debug("Error while getting power state %s", error);
			} else {
				parseString(body, function (err, result) {
					if(error) {
						that.log("Error while parsing %s", err);
					} else {
						var manufacturer = result.root.device[0].manufacturer[0];
						var modelName = (' ' + result.root.device[0].modelName[0]).slice(1);
						var serialNumber = result.root.device[0].serialNumber[0];
						var firmwareRevision = result.root.device[0].deviceList[0].device[3].firmware_version[0];

						that.log.debug('Manufacturer: %s', manufacturer);
						that.log.debug('Model: %s', modelName);
						that.log.debug('Serialnumber: %s', serialNumber);
						that.log.debug('Firmware: %s', firmwareRevision);
					}
				});
			}
		});

		this.informationService = new Service.AccessoryInformation();
		this.informationService
			.setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
			.setCharacteristic(Characteristic.Model, this.modelName)
			.setCharacteristic(Characteristic.SerialNumber, this.serialNumber)
			.setCharacteristic(Characteristic.FirmwareRevision, this.firmwareRevision);
	
		this.enabledServices.push(this.informationService);
	}
	/*****************************************
	* End of Setup services
	****************************************/


	
	/*****************************************
	 * Start of TV integration service 
	 ****************************************/
	setupTvService() {
		this.tvService = new Service.Television(this.name, 'tvService');
		this.tvService
			.setCharacteristic(Characteristic.ConfiguredName, this.name);
		this.tvService
			.setCharacteristic(Characteristic.SleepDiscoveryMode, Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);
		this.tvService
			.getCharacteristic(Characteristic.Active)
			.on('get', this.getPowerState.bind(this))
			.on('set', this.setPowerState.bind(this));
		this.tvService
			.getCharacteristic(Characteristic.ActiveIdentifier)
			.on('set', (inputIdentifier, callback) => {
				this.log.debug('Denon - input source changed, new input source identifier: %d, source appId: %s', inputIdentifier, this.inputAppIds[inputIdentifier]);
				this.setAppSwitchState(true, callback, this.inputAppIds[inputIdentifier]);
			});
		this.tvService
			.getCharacteristic(Characteristic.RemoteKey)
			.on('set', this.remoteKeyPress.bind(this));
		this.tvService
			.getCharacteristic(Characteristic.PowerModeSelection)
			.on('set', (newValue, callback) => {
				if (this.connected) {
					request('http://' + this.ip + ':8080/goform/formiPhoneAppDirect.xml?' + this.menuButton, function(error, response, body) {});
				} 
				callback();
			});


		this.enabledServices.push(this.tvService);

		this.setupTvSpeakerService();
		this.setupInputSourcesService();
	}

	setupTvSpeakerService() {
		this.tvSpeakerService = new Service.TelevisionSpeaker(this.name + ' Volume', 'tvSpeakerService');
		this.tvSpeakerService
			.setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE)
			.setCharacteristic(Characteristic.VolumeControlType, Characteristic.VolumeControlType.ABSOLUTE);
		this.tvSpeakerService
			.getCharacteristic(Characteristic.VolumeSelector)
			.on('set', (state, callback) => {
				this.log.debug('Denon - volume change over the remote control (VolumeSelector), pressed: %s', state === 1 ? 'Down' : 'Up');
				this.setVolumeSwitch(state, callback, !state);
			});

		this.tvService.addLinkedService(this.tvSpeakerService);
		this.enabledServices.push(this.tvSpeakerService);
	}

	setupInputSourcesService() {
		this.log.debug('setupInputSourcesService');
		if (this.inputs === undefined || this.inputs === null || this.inputs.length <= 0) {
			return;
		}

		if (Array.isArray(this.inputs) === false) {
			this.inputs = [this.inputs];
		}

		let savedNames = {};

		this.inputAppIds = new Array();
		this.inputs.forEach((value, i) => {

			// get appid
			let appId = null;

			if (value.appId !== undefined) {
				appId = value.appId;
			} else {
				appId = value;
			}

			// get name		
			let inputName = appId;

			if (savedNames && savedNames[appId]) {
				inputName = savedNames[appId];
			} else if (value.name) {
				inputName = value.name;
			}

			// if appId not null or empty add the input
			if (appId !== undefined && appId !== null && appId !== '') {
				appId = appId.replace(/\s/g, ''); // remove all white spaces from the string

				let tmpInput = new Service.InputSource(appId, 'inputSource' + i);
				tmpInput
					.setCharacteristic(Characteristic.Identifier, i)
					.setCharacteristic(Characteristic.ConfiguredName, inputName)
					.setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED)
					.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.APPLICATION)
					.setCharacteristic(Characteristic.CurrentVisibilityState, Characteristic.CurrentVisibilityState.SHOWN);

				tmpInput
					.getCharacteristic(Characteristic.ConfiguredName)
					.on('set', (name, callback) => {
						savedNames[appId] = name;
						callback()
					});

				this.tvService.addLinkedService(tmpInput);
				this.enabledServices.push(tmpInput);
				this.inputAppIds.push(appId);
			}

		});
	}	
	/*****************************************
	* End of TV integration service 
	****************************************/

	/*****************************************
	 * Start of legacy service 
	 ****************************************/
	setupLegacyService() {
		this.powerService = new Service.Switch(this.name);
		this.powerService
			.getCharacteristic(Characteristic.On)
			.on('get', this.getPowerState.bind(this))
			.on('set', this.setPowerState.bind(this));

		this.enabledServices.push(this.powerService);
	}

	/*
	 * This will start a polling loop that goes on forever and updates
	 * the on characteristic periodically.
	 */

	pollForUpdates() {
		this.log.debug('pollForUpdates');

		// if(!this.task_is_running){
		// 	this.task_is_running = true;

			var that = this;
			request('http://' + that.ip + ':8080/goform/formMainZone_MainZoneXmlStatusLite.xml', function(error, response, body) {
				if(error) {
					// that.log.debug("Error while getting power state %s", error);
					that.connected = false;
				} else {
					parseString(body, function (err, result) {
						if(error) {
							// that.log.debug("Error while parsing %s", err);
						}
						else {	
							that.log.debug("Got power state to be %s", result.item.Power[0].value[0]);
							that.log.debug("Got input state to be %s", result.item.InputFuncSelect[0].value[0]);

							//It is on if it is powered and the correct input is selected.
							if (result.item.Power[0].value[0] === 'ON' && (result.item.InputFuncSelect[0].value[0] == that.requiredInput || that.pollInputAll)) {
								that.connected = true;
							} else {
								that.connected = false;
							}
							if (that.powerService) {
								//that.log("Updating remote change of state...")
								that.powerService.getCharacteristic(Characteristic.On).updateValue(that.connected);
							}
						}
					});
				}
			});
		// }
	}
	/*****************************************
	 * End of legacy service 
	 ****************************************/


	/*****************************************
	 * Start of helper methods
	 ****************************************/
	updateTvStatus(error, tvStatus) {
		// this.log.debug('updateTvStatus state: %s', this.connected ? 'On' : 'Off');

		if (!tvStatus) {
			if (this.powerService) this.powerService.getCharacteristic(Characteristic.On).updateValue(false);
			if (this.tvService) this.tvService.getCharacteristic(Characteristic.Active).updateValue(false); //tv service
			if (this.volumeService) this.volumeService.getCharacteristic(Characteristic.On).updateValue(false);
		} else {
			if (this.powerService) this.powerService.getCharacteristic(Characteristic.On).updateValue(true);
			if (this.tvService) this.tvService.getCharacteristic(Characteristic.Active).updateValue(true); //tv service
		}
	}
	/*****************************************
	 * End of helper methods
	 ****************************************/

 	/*****************************************
	 * Start of Homebridge Setters/Getters
	 ****************************************/
	checkTVState(callback) {
		// this.log.debug(' ');
		// this.log.debug('checkTVState state 1: %s', this.connected ? 'On' : 'Off');
		
		var that = this;

		request('http://' + this.ip + ':8080/goform/formMainZone_MainZoneXmlStatusLite.xml', function(error, response, body) {
			if(error) {
				that.log.debug("Error while getting power state %s", error);
				that.connected = false;
			} else {
				parseString(body, function (err, result) {
				if(error) {
					that.log.debug("Error while parsing %s", err);
				}
				else {		
					//It is on if it is powered and the correct input is selected.
					if ( result.item.Power[0].value[0] === 'ON' ) {
						that.connected = true;
					} else {
						that.connected = false;
					}
				}
				});
			}
			// that.log.debug('checkTVState state 2: %s', that.connected ? 'On' : 'Off');
		});
		callback(null, this.connected);
	}


	getPowerState(callback) {
		this.log.debug('getPowerState');
		callback(null, this.connected);
	}

	setPowerState(state, callback) {
		this.log.debug('setPowerState state: %s', state ? 'On' : 'Off');
		var that = this;
	
		var stateString = (state ? 'On' : 'Standby');
	
		request('http://' + that.ip + ':8080/goform/formiPhoneAppPower.xml?1+Power' + stateString, function(error, response, body) {
			if(error) {
				that.log.debug("Error while setting power state %s", error);
				callback(error);
			} else if(state) {
				/* Switch to correct input if switching on and legacy service */
				if (!this.isTvService) {
					request('http://' + that.ip + ':8080/goform/formiPhoneAppDirect.xml?SI' + that.requiredInput, function(error, response, body) {
						if(error) {
						  	that.log("Error while switching input %s", error);
						  	callback(error);
						} else {
							that.connected = true;
						  	callback();
						}
					});
				} else {
					that.connected = true;
					callback();
				}
			} else {
				that.connected = false;
				callback();
			}
		});
	}

	setVolume(level, callback) {
		if (this.connected) {
			// this.log.debug('Denon - volume service - setting volume to %s, limit: %s', level, this.volumeLimit);
			// if (level > this.volumeLimit) {
			// 	level = this.volumeLimit;
			// }
			// this.lgtv.request('ssap://audio/setVolume', {
			// 	volume: level
			// });
			callback();
		} else {
			callback(new Error('Denon - TV is not connected, cannot set volume'));
		}
	}

	getVolumeSwitch(callback) {
		callback(null, false);
	}

	setVolumeSwitch(state, callback, isUp) {
		var that = this;
		if (this.connected) {
			var stateString = (isUp ? 'MVUP' : 'MVDOWN');
	
			request('http://' + this.ip + ':8080/goform/formiPhoneAppDirect.xml?' + stateString, function(error, response, body) {
				if(error) {
					that.log.debug("Error while setting volume: %s", error);
					// callback(error);
				} else {
					// callback();
				}
			});
		}
		callback();
	}

	getAppSwitchState(callback, appId) {
		this.log.debug('getAppSwitchState');
		if (this.connected) {
			var that = this;
			request('http://' + this.ip + ':8080/goform/formMainZone_MainZoneXmlStatusLite.xml', function(error, response, body) {
				if(error) {
					that.log.debug("Error while getting power state %s", error);
				} else {
					parseString(body, function (err, result) {
						if(error) {
							that.log.debug("Error while parsing %s", err);
							callback(error);
						}
						else {		
							appId = result.item.InputFuncSelect[0].value[0];
							callback();
						}
					});
				}
			});
		} else {
			callback(null, false);
			setTimeout(this.checkForegroundApp.bind(this, callback, appId), 50);
		}
	}

	setAppSwitchState(state, callback, appId) {
		this.log.debug('setAppSwitchState');
		if (this.connected) {
			if (state) {
				var that = this;
				request('http://' + that.ip + ':8080/goform/formiPhoneAppDirect.xml?SI' + appId, function(error, response, body) {
					if(error) {
						that.log.debug("Error while switching input %s", error);
						callback(error);
					} else {
						callback();
					}
				});

			}
		} else {
			callback();
		}
	}

	remoteKeyPress(remoteKey, callback) {
		this.log.debug('Denon - remote key pressed: %d', remoteKey);
		var ctrlString = '';

		switch (remoteKey) {
			case Characteristic.RemoteKey.REWIND:
				break;
			case Characteristic.RemoteKey.FAST_FORWARD:
				break;
			case Characteristic.RemoteKey.NEXT_TRACK:
				break;
			case Characteristic.RemoteKey.PREVIOUS_TRACK:
				break;
			case Characteristic.RemoteKey.ARROW_UP:
				ctrlString = 'MNCUP';
				break;
			case Characteristic.RemoteKey.ARROW_DOWN:
				ctrlString = 'MNCDN';
				break;
			case Characteristic.RemoteKey.ARROW_LEFT:
				ctrlString = 'MNCLT';
				break;
			case Characteristic.RemoteKey.ARROW_RIGHT:
				ctrlString = 'MNCRT';
				break;
			case Characteristic.RemoteKey.SELECT:
				ctrlString = 'MNENT';
				break;
			case Characteristic.RemoteKey.BACK:
				ctrlString = 'MNRTN';
				break;
			case Characteristic.RemoteKey.EXIT:
				break;
			case Characteristic.RemoteKey.PLAY_PAUSE:
				break;
			case Characteristic.RemoteKey.INFORMATION:
				ctrlString = this.infoButton;
				break;
		}

		var that = this;
		if (this.connected) {
			request('http://' + this.ip + ':8080/goform/formiPhoneAppDirect.xml?' + ctrlString, function(error, response, body) {
				// callback();
			});
		}
		callback();
	}

	getServices() {

		return this.enabledServices;
	} 	
	/*****************************************
	* End of Homebridge Setters/Getters
	****************************************/

}

