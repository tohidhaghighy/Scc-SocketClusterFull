const http = require('http');
const eetase = require('eetase');
const socketClusterServer = require('socketcluster-server');
const express = require('express');
const serveStatic = require('serve-static');
const path = require('path');
const morgan = require('morgan');
const uuid = require('uuid');
const sccBrokerClient = require('scc-broker-client');

const ENVIRONMENT = process.env.ENV || 'dev';
const SOCKETCLUSTER_PORT = process.env.SOCKETCLUSTER_PORT || 8000;
const SOCKETCLUSTER_WS_ENGINE = process.env.SOCKETCLUSTER_WS_ENGINE || 'ws';
const SOCKETCLUSTER_SOCKET_CHANNEL_LIMIT = Number(process.env.SOCKETCLUSTER_SOCKET_CHANNEL_LIMIT) || 1000;
const SOCKETCLUSTER_LOG_LEVEL = process.env.SOCKETCLUSTER_LOG_LEVEL || 2;

const SCC_INSTANCE_ID = uuid.v4();
const SCC_STATE_SERVER_HOST = '172.24.33.22';
const SCC_STATE_SERVER_PORT = 7777;
const SCC_MAPPING_ENGINE = process.env.SCC_MAPPING_ENGINE || null;
const SCC_CLIENT_POOL_SIZE = process.env.SCC_CLIENT_POOL_SIZE || null;
const SCC_AUTH_KEY = process.env.SCC_AUTH_KEY || null;
const SCC_INSTANCE_IP = process.env.SCC_INSTANCE_IP || null;
const SCC_INSTANCE_IP_FAMILY = process.env.SCC_INSTANCE_IP_FAMILY || null;
const SCC_STATE_SERVER_CONNECT_TIMEOUT = Number(process.env.SCC_STATE_SERVER_CONNECT_TIMEOUT) || null;
const SCC_STATE_SERVER_ACK_TIMEOUT = Number(process.env.SCC_STATE_SERVER_ACK_TIMEOUT) || null;
const SCC_STATE_SERVER_RECONNECT_RANDOMNESS = Number(process.env.SCC_STATE_SERVER_RECONNECT_RANDOMNESS) || null;
const SCC_PUB_SUB_BATCH_DURATION = Number(process.env.SCC_PUB_SUB_BATCH_DURATION) || null;
const SCC_BROKER_RETRY_DELAY = Number(process.env.SCC_BROKER_RETRY_DELAY) || null;

let agOptions = {protocolVersion: 1};
//token usage : [Receiver Client, Api1, Native Mobile, Api2]
const tokens = ['39a3ea816dfc49328ca72eb764009917','ae490b57eced4be98827c3146f759998','8c15be3ee68b4f678ecbae054b5038cc','6e2332c671914469a0de511f1049e92b'];

if (process.env.SOCKETCLUSTER_OPTIONS) {
  let envOptions = JSON.parse(process.env.SOCKETCLUSTER_OPTIONS);
  Object.assign(agOptions, envOptions);
}

let httpServer = eetase(http.createServer());
let agServer = socketClusterServer.attach(httpServer, agOptions);

let expressApp = express();
if (ENVIRONMENT === 'dev') {
  // Log every HTTP request. See https://github.com/expressjs/morgan for other
  // available formats.
  expressApp.use(morgan('dev'));
}
expressApp.use(serveStatic(path.resolve(__dirname, 'public')));

// Add GET /health-check express route
expressApp.get('/health-check', (req, res) => {
  res.status(200).send('OK');
});

// HTTP request handling loop.
(async () => {
  for await (let requestData of httpServer.listener('request')) {
    expressApp.apply(null, requestData);
  }
})();

let category = {};
let appConnected = {};
// SocketCluster/WebSocket connection handling loop.
(async () => {
  for await (let {socket} of agServer.listener('connection')) {
    var headers = socket.request.headers,
		query = url.parse(socket.request.url, true).query,
		device = query.device || 'desktop',
		accessToken = query.accessToken || headers.accesstoken || '',
		appC = tokens.indexOf(accessToken);
	category[device] = (category[device] || 0) + 1;
	appConnected[appC] = (appConnected[appC] || 0) + 1;
	
	(async () => {
      // Set up a loop to handle remote transmitted events.
      for await (let data of socket.receiver('clientCount')) {
        agServer.exchange.transmitPublish('admin', {id: SCC_INSTANCE_ID, cat: category, app: appConnected, status: {clientsCount: agServer.clientsCount} });
      }
    })();
	
	agServer.exchange.transmitPublish('admin', {id: SCC_INSTANCE_ID, cat: category, app: appConnected, status: {clientsCount: agServer.clientsCount} });
  }
})();

// SocketCluster/WebSocket disconnection handling loop.
(async () => {
  for await (let {socket} of agServer.listener('disconnection')) {
	var headers = socket.request.headers,
		query = url.parse(socket.request.url, true).query,
		device = query.device || 'desktop',
		accessToken = query.accessToken || headers.accesstoken || '',
		appC = tokens.indexOf(accessToken);
	category[device] = (category[device] || 0) - 1;
	appConnected[appC] = (appConnected[appC] || 0) - 1;

	agServer.exchange.transmitPublish('admin', {id: SCC_INSTANCE_ID, cat: category, app: appConnected, status: {clientsCount: agServer.clientsCount} });
  }
})();

// SocketCluster/WebSocket subscription handling loop.
(async () => {
	for await (let {socket, channel} of agServer.listener('subscription')) {
		if (channel.indexOf('depth-') == 0)
			agServer.exchange.transmitPublish('subscription', {type:'on', name: channel });	
	}
})();

// SocketCluster/WebSocket unsubscription handling loop.
(async () => {
	for await (let {socket, channel} of agServer.listener('unsubscription')) {
		if (channel.indexOf('depth-') == 0)
			agServer.exchange.transmitPublish('subscription', {type:'un', name: channel });	
	}
})();


httpServer.listen(SOCKETCLUSTER_PORT);

if (SOCKETCLUSTER_LOG_LEVEL >= 1) {
  (async () => {
    for await (let {error} of agServer.listener('error')) {
      console.error(error);
    }
  })();
}

if (SOCKETCLUSTER_LOG_LEVEL >= 2) {
  console.log(
    `   ${colorText('[Active]', 32)} SocketCluster worker with PID ${process.pid} is listening on port ${SOCKETCLUSTER_PORT}`
  );

  (async () => {
    for await (let {warning} of agServer.listener('warning')) {
      console.warn(warning);
    }
  })();
}

function colorText(message, color) {
  if (color) {
    return `\x1b[${color}m${message}\x1b[0m`;
  }
  return message;
}

if (SCC_STATE_SERVER_HOST) {
  // Setup broker client to connect to SCC.
  let sccClient = sccBrokerClient.attach(agServer.brokerEngine, {
    instanceId: SCC_INSTANCE_ID,
    instancePort: SOCKETCLUSTER_PORT,
    instanceIp: SCC_INSTANCE_IP,
    instanceIpFamily: SCC_INSTANCE_IP_FAMILY,
    pubSubBatchDuration: SCC_PUB_SUB_BATCH_DURATION,
    stateServerHost: SCC_STATE_SERVER_HOST,
    stateServerPort: SCC_STATE_SERVER_PORT,
    mappingEngine: SCC_MAPPING_ENGINE,
    clientPoolSize: SCC_CLIENT_POOL_SIZE,
    authKey: SCC_AUTH_KEY,
    stateServerConnectTimeout: SCC_STATE_SERVER_CONNECT_TIMEOUT,
    stateServerAckTimeout: SCC_STATE_SERVER_ACK_TIMEOUT,
    stateServerReconnectRandomness: SCC_STATE_SERVER_RECONNECT_RANDOMNESS,
    brokerRetryDelay: SCC_BROKER_RETRY_DELAY
  });

  if (SOCKETCLUSTER_LOG_LEVEL >= 1) {
    (async () => {
      for await (let {error} of sccClient.listener('error')) {
        error.name = 'SCCError';
        console.error(error);
      }
    })();
  }
}


agServer.setMiddleware(agServer.MIDDLEWARE_INBOUND, async (middlewareStream) => {
	try{
	  for await (let action of middlewareStream) {
		if (action.type === action.PUBLISH_IN) {
			if (action.data && action.data.from && action.data.from === "XSender!Soshyant"){
				delete action.data.from;
				action.allow();
			}else{
				let error = new Error(
				  'Forbidden access to publish stream on channel'
				);
				error.name = 'ForbiddenAccess';
				console.log(`Forbidden access to publish stream on channel`);
				action.block(error);
			}
			continue;
		}
		// Any unhandled case will be allowed by default.
		action.allow();
	  }
	}catch(error){
		// ignore
	}
});

agServer.setMiddleware(agServer.MIDDLEWARE_HANDSHAKE, async (middlewareStream) => {
	try{
	  for await (let action of middlewareStream) {
		if (action.type === action.HANDSHAKE_SC) {
			let headers = action.request.headers,
				query = url.parse(action.request.url, true).query,
				accessToken = query.accessToken || headers.accesstoken || '',
				origin = action.request.headers.origin || '';
			if (origin.indexOf('farabixo.com') >= 0 || tokens.indexOf(accessToken) >= 0) {
				action.allow();
			}else{
				let error = new Error(
				  'Handshake not authorized'
				);
				error.name = 'UnauthorizedHandshake';
				console.log(`Handshake not authorized on ${origin}#${accessToken}`);
				// Block and close socket with custom 4500 status code.
				action.block(error, 4500);
			}
			continue;
		}
		// Any unhandled case will be allowed by default.
		action.allow();
	  }
	}catch(error){
		// ignore
	}
});
