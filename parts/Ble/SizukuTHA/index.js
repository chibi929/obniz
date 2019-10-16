class SizukuTHA {
  constructor() {
    this.keys = ['serial'];
    this.requiredKeys = ['serial'];
    this.peripheral = null;
    this.services = {};
    this.temperature = null;
    this.humidity = null;
    this.pressure = null;
    this._timeout = false;
    this._connected = false;
  }

  static info() {
    return {
      name: 'SizukuTHA',
    };
  }

  wired(obniz) {
    this.obniz = obniz;
  }

  async findWait() {
    let target = {
      localName: 'Sizuku_tha' + this.params.serial,
    };
    console.log('Scanning for ' + target.localName);
    this.peripheral = await this.obniz.ble.scan.startOneWait(target);
    console.log('BLE: ', this.peripheral);
    return this.peripheral;
  }

  async connectWait() {
    if (!this.peripheral) {
      await this.findWait();
    }
    if (!this.peripheral) {
      await this.connectWait();
    } else {
      let ret = await this.peripheral.connectWait();
      this._connected = ret;
      console.log('Connected? ', ret);
    }
  }

  async discoverServices() {
    if (this._connected) {
      let services = await this.peripheral.discoverAllServicesWait();
      Array.from(services).forEach(service => {
        this.services[service.uuid] = service;
      });
      console.log('Services: ', this.services);
    }
  }

  printUUIDs() {
    this.services.forEach(currentItem => {
      console.log('Service: ' + currentItem['service'].uuid);
      currentItem['characteristics'].forEach(currentItem => {
        console.log('Chara: ' + currentItem.uuid);
      });
    });
  }

  async disconnectWait() {
    if (this.periperal && this.periperal.connected) {
      this.periperal.disconnectWait();
    }
  }

  _parseSensor(n, slen, elen, flen) {
    let sgn = slen ? (n >>> 11) & 0b1 : 0; // sign
    let max = Math.pow(2, elen) - 1; // maximum of exponent
    let exp = (n >>> flen) & max; // exponent
    let fra = 0; // fraction
    for (let i = 0; i < flen; i++) {
      if ((n >>> (flen - i - 1)) & 0b1) {
        fra += Math.pow(2, -(i + 1));
      }
    }
    if (exp === 0 && fra === 0) {
      return 0;
    } else if (exp === 0 && fra !== 0) {
      let m = Math.pow(2, elen - 1) - 1; // median (7 or 15)
      let v = Math.pow(-1, sgn) * fra * Math.pow(2, 1 - m);
      return v;
    } else if (exp >= 1 && exp <= max - 1) {
      let m = Math.pow(2, elen - 1) - 1; // median (7 or 15)
      let v = Math.pow(-1, sgn) * (1 + fra) * Math.pow(2, exp - m);
      return v;
    } else if (exp === max && fra === 0) {
      return Infinity;
    } else {
      return NaN;
    }
  }

  _parseAdvData(data) {
    let intData = (data[ADV_LENGTH - 2] << 8) + data[ADV_LENGTH - 1];
    let sensorId = intData >>> 12;
    let n = intData & 0b0000111111111111;
    if (sensorId === 1) {
      this.temperature = this._parseSensor(n, 1, 4, 7);
    } else if (sensorId === 2) {
      this.humidity = this._parseSensor(n, 0, 4, 8);
    } else if (sensorId === 3) {
      this.pressure = this._parseSensor(n, 0, 5, 7);
    }
  }

  _createPropertyBlockBuffer(pid, valbuf) {
    let pidbuf = Buffer.from([pid]);
    let len = 0;
    if (valbuf) {
      len = valbuf.length;
    }
    let lenbuf = Buffer.alloc(4);
    lenbuf.writeUInt32LE(len);
    lenbuf = lenbuf.slice(0, 3);
    let buflist = [pidbuf, lenbuf];
    if (valbuf) {
      buflist.push(valbuf);
    }
    return Buffer.concat(buflist);
  }

  _getPayloadTemperature() {
    let bytes = [];
    let header = Buffer.alloc(1);
    header.writeUInt8(0x03);
    bytes.push(header);
    let serviceId = Buffer.alloc(1);
    serviceId.writeUInt8(0x03);
    bytes.push(serviceId);
    let messageId = Buffer.alloc(2);
    messageId.writeUInt16LE('02');
    bytes.push(messageId);
    let payloadSize = Buffer.from([2]);
    bytes.push(payloadSize);
    let payloadSensor = Buffer.from([0x04]);
    bytes.push(this._createPropertyBlockBuffer(0x02, payloadSensor));
    let payloadStatus = Buffer.from([1]);
    bytes.push(this._createPropertyBlockBuffer(0x03, payloadStatus));
    return Buffer.concat(bytes);
  }

  /*
   * Attempt to get sensor data via services.
   */
  subscribeTemperature() {
    console.log('Making request for temp');
    let c = this.peripheral.findCharacteristic({
      service_uuid: SERV_UUID,
      characteristic_uuid: CHAR_UUID,
    });
    if (c != null) {
      let payload = this._getPayloadTemperature();
      console.log('Request ', payload.toJSON());
      c.write(payload.toJSON().data);
    } else {
      console.log('Could not find characteristic.');
    }
  }

  /*
   * This method will retrieve sensor values from advertisment data.
   * It scans for ble device in order to get the updated sensor values 
   * so it is quite slow.
   * Not very elegant so a better approach is needed based on services.
   */
  async getLatestData(timeout) {
    await this.peripheral.disconnectWait();
    this.humidity = null;
    this.temperature = null;
    this.pressure = null;
    let peri = null;
    let count = 0;
    setTimeout(
      function(obj) {
        obj._timeout = true;
      },
      timeout,
      this
    );
    while (
      peri === null ||
      this.humidity === null ||
      this.temperature === null ||
      this.pressure === null
    ) {
      if (this._timeout) break;
      console.log('loop ', count, this._timeout);
      peri = await this.findWait();
      if (peri != null && this.peripheral.adv_data.length === ADV_LENGTH) {
        this._parseAdvData(this.peripheral.adv_data);
      }
      count++;
    }
    return {
      temperature: this.temperature,
      humidity: this.humidity,
      pressure: this.pressure,
    };
  }
}

if (typeof module === 'object') {
  module.exports = SizukuTHA;
}

const ADV_LENGTH = 31;
const SERV_UUID = 'b3b36901-50d3-4044-808d-50835b13a6cd';
const CHAR_UUID = 'b3b39101-50d3-4044-808d-50835b13a6cd';
//const SENSOR_TEMP = 1;
//const SENSOR_HUM = 2;
//const SENSOR_PRES = 3;
//const SENSOR_BAT = 4;
