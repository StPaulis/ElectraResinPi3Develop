const amqp = require('amqp-connection-manager');
const axios = require('axios');
var Gpio = require('onoff').Gpio;
const storage = require('node-persist');

const nodeId = process.env.NODE_ID || 7;
const server_url = process.env.SERVER_URL || 'localhost:2853';
const RMQ_IP = process.env.RMQ_IP || 'localhost';
const IS_PROD = process.env.IS_PROD || false;
var pinReaders = [];
var pinWriters = [];
let boilerStatus = true;
let rmqConn = null;


initStorage();
setJobToStorage(0, Date.now()); // test if working
initPower();

function initPower() {
  axios.get(`http://${server_url}/api/NodePin/node/${nodeId}/write`)
    .then(function (response) {
      console.log('[Power Write] Init:' + JSON.stringify(response.data));
      response.data.forEach(function (nodePin) {

        if (IS_PROD) {
          pinWriters.push({
            gpio: new Gpio(nodePin.controllerPin, 'out'),
            pin: nodePin.controllerPin
          });
        } else {

          let virtualGpio = {
            writeSync: (value) => {
              console.log(`Virtual Pin ${nodePin.controllerPin} is now ${value}`);
            }
          };

          pinWriters.push({
            gpio: virtualGpio,
            pin: nodePin.controllerPin
          });
        }
        if (nodePin.pinModeId === 4) {
          boilerStatus = nodePin.status;
        }
        blink(nodePin.status, nodePin.controllerPin);

        // Setup job again if exists
        const jobFromStorage = getJobFromStorage(nodePin.controllerPin);
        if (jobFromStorage) {
          console.log('Pin ' + nodePin.controllerPin + ' boot from storage');
          const nowInEpoch =  Date.now();
          const fireAt = jobFromStorage - nowInEpoch;
          setTimeout(() => {
            removeJobFromStorage(nodePin.controllerPin);
            receiveFromRmqToWrite(JSON.stringify(
              {
                Id: nodePin.controllerPin,
                Status: false,
                ClosedinMilliseconds: 0, 
                Service: 'Power_Write:' + nodeId.toString(), 
                PinModeId: nodePin.pinModeId, 
                Expiring: nowInEpoch + 15, 
                JobGuid: '00000000-0000-0000-0000-000000000000', 
                NodeId: nodeId.toString()
              }));
          }, fireAt > 100 ? fireAt : 100);
        }
      });

      initPowerRead();
      subscribeWritersToRMQ();
    })
    .catch(function (error) {
      console.log('[Power Write] Restarting service on init' + error);
      initPower();
    });

  function initPowerRead() {

    axios.get(`http://${server_url}/api/NodePin/node/${nodeId}/read`)
      .then(function (response) {
        console.log('[Power Read] Init:' + JSON.stringify(response.data));
        response.data.forEach(function (nodePin) {
          pinReaders.push({
            gpio: getGpioReader(nodePin),
            status: 0,
            pin: nodePin
          });

          const _status = pinReaders.find(x => x.pin === nodePin).gpio.readSync();
          pinReaders.find(x => x.pin === nodePin).status = _status;

          changeStatusAndSendToRmq({
            id: nodePin,
            status: _status === 1 ? true : false,
            service: 'Power_Read',
            nodeId: nodeId
          });

          initGpioReader(pinReaders.find(x => x.pin === nodePin).gpio);
        });
      })
      .catch(function (error) {
        console.log('[Power Read] Restarting service on init' + error);
        initPowerRead();
      });
  }
}

function handleWrite(model) {
  if (model.PinModeId === 4) {
    blink(!boilerStatus, model.Id);

    setTimeout(function () {
      blink(boilerStatus, model.Id);
    }, 100);

  } else {
    blink(model.Status, model.Id);
  }

  if (model.ClosedinMilliseconds) {
    setJobToStorage(model.Id, Date.now() + model.ClosedinMilliseconds);
    console.log(`[PowerWrite]: Auto Close Set for Pin ${model.Id} to ${!model.Status} in ${model.ClosedinMilliseconds} milliseconds`);
    setTimeout(function () {
      model.Status = !model.Status;
      model.ClosedinMilliseconds = 0;
      console.log(`[PowerWrite]: Auto Close Set for Pin ${model.Id} to ${!model.Status} `);
      removeJobFromStorage(model.Id);
      receiveFromRmqToWrite(JSON.stringify(model));
    }, model.ClosedinMilliseconds);
  }
}

function initGpioReader(gpio) {
  gpio.watch((err, value) => {
    if (err) {
      console.log(err);
      exit();
    }

    console.log(`Pin ${gpio._gpio} changed, New value: ${value}`);
    changeStatusAndSendToRmq({
      id: gpio._gpio,
      status: value === 1 ? true : false,
      service: 'Power_Read',
      nodeId: nodeId
    });
  });
}

function getGpioReader(pin) {
  if (IS_PROD) {
    return new Gpio(pin, 'in', 'both', 'both');
  } else {
    let virtualGpio = {
      watch: (err, value) => {
        console.log(`Gpio Pin ${pin} is virtual reader!`);
        return 0;
      },
      readSync: (value) => {
        console.log('Read Sync in virtual mode on pin:' + pin);
      }
    };
    return virtualGpio;
  }
}

function subscribeWritersToRMQ() {
  if (!rmqConn) {
    rmqConn = amqp.connect([`amqp://${RMQ_IP}`]);
  };

  rmqConn.createChannel({
    setup: function (channel) {
      return Promise.all([
        channel.assertQueue(`Power_Write:${nodeId}`, {
          durable: false
        }),
        channel.consume(`Power_Write:${nodeId}`, function (msg) {
          receiveFromRmqToWrite(bin2string(msg.content));
        }, {
          noAck: true
        })
      ]);
    }
  });
}

function receiveFromRmqToWrite(msg) {
  var model = JSON.parse(msg);

  try {
    handleWrite(model);
  } catch (error) {
    console.log(error);
    exit();
  }

  model.NodeId = nodeId;
  var newMsg = JSON.stringify(model);

  sendToRmq(newMsg);
}

function changeStatusAndSendToRmq(model) {

  const _LastStatus = pinReaders.filter(x => x.pin === model.id)[0].status;
  if (model.status === _LastStatus) return;

  pinReaders.filter(x => x.pin === model.id)[0].status = model.status;

  var newMsg = JSON.stringify(model);
  sendToRmq(newMsg);
}

function sendToRmq(msg) {
  let rmqChannel = rmqConn.createChannel({
    setup: function (channel) {
      return channel.assertQueue('Server', {
        durable: false
      });
    }
  });

  rmqChannel.sendToQueue('Server', new Buffer.from(msg))
    .then(function () {
      rmqChannel.close();
      return console.log(" [AMQPv4] Sent Message to Home Server:" + msg);
    }).catch(function (err) {
      rmqChannel.close();
      return console.log(" [AMQPv4] Rejected Message to Home Server:" + msg);
    });
}

function blink(status, id) {
  pinWriters.find(x => x.pin === id).gpio.writeSync(status ? 1 : 0);
}

function bin2string(array) {
  var result = "";
  for (var i = 0; i < array.length; ++i) {
    result += (String.fromCharCode(array[i]));
  }
  return result;
}

function initStorage() {
  storage.initSync({
    dir: '/usr/src/app/data',

    stringify: JSON.stringify,

    parse: JSON.parse,

    encoding: 'utf8',

    logging: false,  // can also be custom logging function

    ttl: false, // ttl* [NEW], can be true for 24h default or a number in MILLISECONDS or a valid Javascript Date object

    expiredInterval: 60 * 60 * 1000, // every 1 hour the process will clean-up the expired cache

    // in some cases, you (or some other service) might add non-valid storage files to your
    // storage dir, i.e. Google Drive, make this true if you'd like to ignore these files and not throw an error
    forgiveParseErrors: false

  });
}
function setJobToStorage(pinId, time) {
  console.log('setJobToStorage:' + pinId + time.toString())
  storage.setItemSync(pinId.toString(), time.toString());
}
function getJobFromStorage(pinId) {
  storage.getItemSync(pinId.toString());
}
function removeJobFromStorage(pinId) {
  storage.removeItemSync(pinId.toString());
}

// #region Safely closing
function exitHandler(options, err) {
  if (options.cleanup && IS_PROD) {
    pinWriters.forEach(x => x.gpio.unexport());
    pinWriters = [];
  }
  if (err) console.log(err.stack);
  if (options.exit) exit();
}

function exit() {
  if (IS_PROD && pinWriters) {
    pinWriters.forEach(x => x.gpio.unexport());
  }

  if (rmqConn) {
    rmqConn.close();
    rmqConn = null;
  }

  initPower();
}

//do something when app is closing
process.on('exit', exitHandler.bind(null, {
  cleanup: true
}));

//catches ctrl+c event
process.on('SIGINT', exitHandler.bind(null, {
  exit: true
}));

// catches "kill pid" (for example: nodemon restart)
process.on('SIGUSR1', exitHandler.bind(null, {
  exit: true
}));
process.on('SIGUSR2', exitHandler.bind(null, {
  exit: true
}));

//catches uncaught exceptions
process.on('uncaughtException', exitHandler.bind(null, {
  exit: true
}));

// #endregion