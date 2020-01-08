const primus = require('primus');
const request = require('request');
const socket = require('./socket');
const relay = require('../relay');
const logger = require('../log');
const version = require('../version');

module.exports = ({ port = null, config = {}, filters = {} }) => {
  logger.info({ version }, 'running in client mode');

  const identifyingMetadata = {
    version,
    filters,
  };

  const io = socket({
    token: config.brokerToken,
    url: config.brokerServerUrl,
    filters: filters.private,
    config,
    identifyingMetadata,
  });

  // start the local webserver to listen for relay requests
  const { app, server } = require('../webserver')(config, port);

  const getHealthData = () => {
    // healthcheck state depends on websocket connection status
    // value of primus.Spark.OPEN means the websocket connection is open
    const isConnOpen = (io.readyState === primus.Spark.OPEN);
    const data = {
      ok: isConnOpen,
      websocketConnectionOpen: isConnOpen,
      brokerServerUrl: io.url.href,
      version,
    };

    return data;
  };

  app.get('/status', async (req, res) => {
    const healthData = getHealthData();
    const systemCheckConfig = getSystemCheckConfiguration();

    const combinedConfig = Object.assign({}, systemCheckConfig, {
      brokerServerUrl: healthData.brokerServerUrl,
      version: healthData.version
    });

    const validationResponse = await makeInternalValidationRequest(systemCheckConfig);

    console.log(validationResponse);

    return res.send(`
        <html>
          <body>
          <h1>Broker Status Page</h1>
          <table>
            <tr>
              <td>Registry connection status</td>
              <td>${healthData.ok === true ? 'OK' : 'NOT OK'}</td>
            </tr>
            <tr>
              <td>SCM connection status</td>
              <td>${validationResponse.ok === true ? 'OK' : 'NOT OK'}</td>
            </tr>
          </table>
          <h2>Configuration</h2>
          <table>
            ${Object.entries(combinedConfig).map(configItem => {
    return `
              <tr>
                <td>${configItem[0]}</td>
                <td>${configItem[1]}</td>
              </tr>
              `;
  }).join('')}
            </table>
          </body>
        </html>
      `);
  });

  // IMPORTANT: defined before relay (`app.all('/*', ...`)
  app.get(config.brokerHealthcheckPath || '/healthcheck', (req, res) => {
    const data = getHealthData();
    const status = data.isConnOpen ? 200 : 500;

    return res.status(status).json(data);
  });

  const getSystemCheckConfiguration = () => {
    const brokerClientValidationMethod =
      config.brokerClientValidationMethod || 'GET';
    const brokerClientValidationTimeoutMs =
      config.brokerClientValidationTimeoutMs || 5000;

    return {
      brokerClientValidationUrl: logger.sanitise(config.brokerClientValidationUrl),
      brokerClientValidationMethod,
      brokerClientValidationTimeoutMs,
    };
  };

  const makeInternalValidationRequest = (systemCheckConfig) => {
    return new Promise((resolve, reject) => {
    // make the internal validation request
      const validationRequestHeaders = {
        'user-agent': 'Snyk Broker client ' + version,
      };

      // set auth header according to config
      if (config.brokerClientValidationAuthorizationHeader) {
        validationRequestHeaders.authorization = config.brokerClientValidationAuthorizationHeader;
      } else if (config.brokerClientValidationBasicAuth) {
        validationRequestHeaders.authorization =
        `Basic ${new Buffer(config.brokerClientValidationBasicAuth).toString('base64')}`;
      }

      request({
        url: systemCheckConfig.brokerClientValidationUrl,
        headers: validationRequestHeaders,
        method: systemCheckConfig.brokerClientValidationMethod,
        timeout: systemCheckConfig.brokerClientValidationTimeoutMs,
        json: true,
        agentOptions: {
          ca: config.caCert, // Optional CA cert
        },
      }, (error, response) => {
        if (error) {
          logger.error(error);
          return reject(error);
        }

        const data = {};
      
        // test logic requires to surface internal data
        // which is best not exposed in production
        if (process.env.TAP) {
          data.testError = error;
          data.testResponse = response;
        }

        const responseStatusCode = response && response.statusCode;
        data.brokerClientValidationUrlStatusCode = responseStatusCode;

        const goodStatusCode = /^2/.test(responseStatusCode);
        if (!goodStatusCode) {
          logger.error(data, response && response.body, 'Systemcheck failed');

          const errorMessage = (responseStatusCode === 401 || responseStatusCode === 403) ? 'Failed due to invalid credentials'
            : 'Status code is not 2xx';
          return reject(errorMessage);
        }

        data.ok = true;
        return resolve(data);
      });
    }
    );};

  // Systemcheck is the broker client's ability to assert the network
  // reachability and some correctness of credentials for the service
  // being proxied by the broker client.
  app.get(config.brokerSystemcheckPath || '/systemcheck', (req, res) => {
    const systemCheckConfig = getSystemCheckConfiguration();

    return makeInternalValidationRequest(systemCheckConfig).then((data) => {
      const response = Object.assign({}, systemCheckConfig, data);
      return res.status(200).json(response);
    }).catch(error => {
      return res.status(500).json({
        ok: false,
        error: error,
        config: systemCheckConfig,
      });
    });
  });

  // relay all other URL paths
  app.all('/*', (req, res, next) => {
    res.locals.io = io;
    next();
  }, relay.request(filters.public));

  return {
    io,
    close: done => {
      logger.info('client websocket is closing');
      server.close();
      io.destroy(function () {
        logger.info('client websocket is closed');
        if (done) {
          return done();
        }
      });
    },
  };
};
