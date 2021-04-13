const amqp = require('amqp-connection-manager');
const axios = require('axios');
const os = require('os');

const nodeId = process.env.NODE_ID || 7;
const dataInterval = +process.env.DATA_INTERVAL || 1000;
const server_url = process.env.SERVER_URL || '127.0.0.1:2853';
const RMQ_IP = process.env.RMQ_IP || 'localhost';
const IS_PROD = process.env.IS_PROD || false;

let sensorsList = [];
const sensorTypes = [
  'Device_Free_Memory',
];
let rmqConn = null;

console.log(`[DATA] Initializing configuration...`);
main();
console.log(`[DATA] Configuration initialized!`);

function main() {
  console.log(`[DATA] Receiving info about device sensors...`);
  axios.get(`http://${server_url}/api/NodePin/node/${nodeId}/sensors`)
    .then(function (response) {
      console.log('[DATA] Info about sensors received: ' + JSON.stringify(response.data));
      response.data.forEach(function (sensor) {
        console.log('Init: ' + JSON.stringify(sensor));
        initSensor(sensor);
        console.log('Sensor initialized');
      });
      console.log(`[DATA] Setup finished! `);

      console.log('[DATA] Create RabbitMq channels and subscribe to listen for messages...');
      subscribeToRMQ();
      console.log('[DATA] RabbitMq channels created and is now listening for messages from the router!');
    })
    .catch(function (error) {
      console.log('[DATA] Restarting service while setting up Outputs', error);
      exit();
    });
}

function initSensor(sensor) {
  const type = sensorTypes.find(x => x === sensor.type);

  if (!type)
    throw new Error('Sensor type did not found');

  sensor.interval = setInterval(function() {
    onSensorRead(sensor);
  }, dataInterval);
  sensor.lastValue = 0;

  sensorsList.push(sensor);
}

function onSensorRead(sensor) {
  switch (sensor.type) {
    case 'Device_Free_Memory':
      readDeviceMemory(sensor);
      break;
    default:
      break;
  }
}

function readDeviceMemory(sensor) {
  const memory = os.freemem();

  const s = sensorsList.find(x => x.id === sensor.id);

  if (Math.floor(s.lastValue) !== Math.floor(memory)) {
    sensor.value = Math.floor(memory);
    sendToRmq(JSON.stringify({
      id: sensor.Id,
      v: memory,
      t: Math.floor(Date.now() / 1000)
    }));
  }
}

function subscribeToRMQ() {
  if (!rmqConn) {
    rmqConn = amqp.connect([`amqp://${RMQ_IP}`]);
  };

  rmqConn.createChannel({
    setup: function (channel) {
      return Promise.all([
        channel.assertQueue(`Data:${nodeId}`, {
          durable: false
        }),
        channel.consume(`Data:${nodeId}`, function (msg) {
          onReceiveFromRmq(bin2string(msg.content));
        }, {
          noAck: true
        })
      ]);
    }
  });
}

function onReceiveFromRmq(msg) {
  var model = JSON.parse(msg);

  try {
    // Do something
  } catch (error) {
    console.log(error);
    exit();
  }

  model.NodeId = nodeId;
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
      return console.log(" [DATA] Sent Message to Router:" + msg);
    }).catch(function (err) {
      rmqChannel.close();
      return console.log(" [AMQPv4] Rejected Message to Router:" + msg);
    });
}

function bin2string(array) {
  var result = "";
  for (var i = 0; i < array.length; ++i) {
    result += (String.fromCharCode(array[i]));
  }
  return result;
}

// #region Safely closing
function exit() {
  if (IS_PROD && sensorsList) {
    sensorsList.forEach(function(s) {
      if (s.interval) clearInterval(s.interval);
    });
    sensorsList = [];
  }

  if (rmqConn) {
    rmqConn.close();
    rmqConn = null;
  }

  process.exit(1);
}

[`exit`, `SIGINT`, `SIGUSR1`, `SIGUSR2`, `uncaughtException`, `SIGTERM`].forEach((eventType) => {
  process.on(eventType, exit.bind(null, { exit: true }, { stack: eventType }));
});
// #endregion