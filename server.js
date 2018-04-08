'use strict';

module.exports = (options) => {
  // libs
  const http = require('http');
  const tldjs = require('tldjs');
  const ss = require('socket.io-stream');
  const uuid = require('uuid/v4');

  // association between subdomains and socket.io sockets
  let socketsBySubdomain = {};

  // bounce incoming http requests to socket.io
  let server = http.createServer(async (req, res) => {
    getTunnelClientStreamForReq(req).then((tunnelClientStream) => {
      tunnelClientStream.on('error', () => {
        req.destroy();
        tunnelClientStream.destroy();
      });

      // Pipe all data from tunnel stream to requesting connection
      tunnelClientStream.pipe(req.connection);

      let reqBody = [];

      // Collect data of POST/PUT request to array buffer
      req.on('data', (data) => {
        reqBody.push(data);
      });

      // Proxy ended GET/POST/PUT/DELETE request to tunnel stream
      req.on('end', () => {
        let messageParts = getHeaderPartsForReq(req);

        // Push request body data
        messageParts.push(Buffer.concat(reqBody).toString());

        // Push delimiter
        messageParts.push('');

        let message = messageParts.join('\r\n');

        tunnelClientStream.write(message);
      });
    }).catch((subdomainErr) => {
      res.statusCode = 502;
      return res.end(subdomainErr.message);
    });
  });

  // pass along HTTP upgrades (i.e. websockets) to tunnels
  server.on('upgrade', (req, socket, head) => {
    getTunnelClientStreamForReq(req).then((tunnelClientStream) => {
      tunnelClientStream.on('error', () => {
        req.destroy();
        socket.destroy();
        tunnelClientStream.destroy();
      });

      // get the upgrade request and send it to the tunnel client
      let messageParts = getHeaderPartsForReq(req);
      messageParts.push(''); // Push delimiter
      let message = messageParts.join('\r\n');
      tunnelClientStream.write(message);

      // pipe data between ingress socket and tunnel client
      tunnelClientStream.pipe(socket).pipe(tunnelClientStream);
    }).catch((subdomainErr) => {
      // if we get an invalid subdomain, this socket is most likely being handled by the root socket.io server
      if (!subdomainErr.message.includes('Invalid subdomain')) {
        socket.end();
      }
    });
  });

  function getTunnelClientStreamForReq (req) {
    return new Promise((resolve, reject) => {
      // without a hostname, we won't know who the request is for
      let hostname = req.headers.host;
      if (!hostname) {
        return reject(new Error('Invalid hostname'));
      }

      // make sure we received a subdomain
      let subdomain = tldjs.getSubdomain(hostname);
      if (!subdomain) {
        return reject(new Error('Invalid subdomain'));
      }

      // tldjs library return subdomain as all subdomain path from the main domain.
      // Example:
      // 1. super.example.com = super
      // 2. my.super.example.com = my.super
      // 3. If we are running the tunnel server on a subdomain, we must strip it from the provided hostname
      if (options.subdomain) {
        subdomain = subdomain.replace(`.${options.subdomain}`, '');
      }

      let clientId = subdomain.toLowerCase();
      let subdomainSocket = socketsBySubdomain[clientId];

      if (!subdomainSocket) {
        return reject(new Error(`${clientId} is currently unregistered or offline.`));
      }

      let requestGUID = uuid();
      ss(subdomainSocket).once(requestGUID, (tunnelClientStream) => {
        resolve(tunnelClientStream);
      });

      subdomainSocket.emit('incomingClient', requestGUID);
    });
  }

  function getHeaderPartsForReq (req) {
    let messageParts = [];

    // Push request data
    messageParts.push([req.method + ' ' + req.url + ' HTTP/' + req.httpVersion]);

    // Push headers data
    for (let i = 0; i < (req.rawHeaders.length - 1); i += 2) {
      messageParts.push(req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1]);
    }

    // Push delimiter
    messageParts.push('');

    return messageParts;
  }

  // socket.io instance
  let io = require('socket.io')(server);
  io.on('connection', (socket) => {
    socket.on('createTunnel', (requestedName) => {
      if (socket.requestedName) {
        // tunnel has already been created
        return;
      }

      // domains are case insensitive
      let reqNameNormalized = requestedName.toLowerCase();

      // make sure the client is requesting an alphanumeric of reasonable length
      if (/[^a-zA-Z0-9]/.test(reqNameNormalized) || reqNameNormalized.length === 0 || reqNameNormalized.length > 63) {
        console.log(new Date() + ': ' + reqNameNormalized + ' -- bad subdomain. disconnecting client.');
        return socket.disconnect();
      }

      // make sure someone else hasn't claimed this subdomain
      if (socketsBySubdomain[reqNameNormalized]) {
        console.log(new Date() + ': ' + reqNameNormalized + ' requested but already claimed. disconnecting client.');
        return socket.disconnect();
      }

      // store a reference to this socket by the subdomain claimed
      socketsBySubdomain[reqNameNormalized] = socket;
      socket.requestedName = reqNameNormalized;
      console.log(new Date() + ': ' + reqNameNormalized + ' registered successfully');
    });

    // when a client disconnects, we need to remove their association
    socket.on('disconnect', () => {
      if (socket.requestedName) {
        delete socketsBySubdomain[socket.requestedName];
        console.log(new Date() + ': ' + socket.requestedName + ' unregistered');
      }
    });
  });

  // http server
  server.listen(options.port, options.hostname);

  console.log(`${new Date()}: socket-tunnel server started on ${options.hostname}:${options.port}`);
};
