const primus = require('primus');
const util = require('util');
const request = require('request');
const asyncRequest = util.promisify(request);

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
          ${validationResponse.error ? `<h2>Errors</h2><code>${validationResponse.error}</code>` : ''}
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
    const { brokerClientValidationMethod = 'GET', brokerClientValidationTimeoutMs = 5000, brokerClientValidationUrl } = config;

    return {
      brokerClientValidationUrl: logger.sanitise(brokerClientValidationUrl),
      brokerClientValidationMethod,
      brokerClientValidationTimeoutMs,
    };
  };

  const makeInternalValidationRequest = async (systemCheckConfig) => {
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

    try {
      const response = await asyncRequest({
        url: systemCheckConfig.brokerClientValidationUrl,
        headers: validationRequestHeaders,
        method: systemCheckConfig.brokerClientValidationMethod,
        timeout: systemCheckConfig.brokerClientValidationTimeoutMs,
        json: true,
        agentOptions: {
          ca: config.caCert, // Optional CA cert
        },
      });

      // TODO: Clean this up
      const data = {};
      
      // TODO: reinstate
      // test logic requires to surface internal data
      // which is best not exposed in production
      // if (process.env.TAP) {
      //   data.testError = error;
      //   data.testResponse = response;
      // }

      const responseStatusCode = response && response.statusCode;
      data.brokerClientValidationUrlStatusCode = responseStatusCode;

      const goodStatusCode = /^2/.test(responseStatusCode);
      if (!goodStatusCode) {
        logger.error(data, response && response.body, 'Systemcheck failed');

        const errorMessage = (responseStatusCode === 401 || responseStatusCode === 403) ? 'Failed due to invalid credentials'
          : 'Status code is not 2xx';
        throw new Error(errorMessage);
      }

      data.ok = true;
      return data;
    } catch (error) {
      logger.error('Validation request failed', error);
      
      return {
        ok: false,
        error: error.message
      };
    }
  };

  // Systemcheck is the broker client's ability to assert the network
  // reachability and some correctness of credentials for the service
  // being proxied by the broker client.
  app.get(config.brokerSystemcheckPath || '/systemcheck', async (req, res) => {
    const systemCheckConfig = getSystemCheckConfiguration();

    try {
      const data = await makeInternalValidationRequest(systemCheckConfig);
      const response = Object.assign({}, systemCheckConfig, data);
      return res.status(200).json(response);
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error,
        config: systemCheckConfig,
      });
    }
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
