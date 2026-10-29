const express = require('express');
const handlebars = require('express-handlebars');
const path = require('path');
const paths = require('./paths');
const defaultRoutes = require('./routes/defaultRoutes');
const userInteractionRoutes = require('./routes/userInteractionRoutes');
const payloadService = require('./services/payloadsService');
const messageLog = require('./services/messageLog');
const { userInteractionService } = require('./services/userInteractionService');

/**
 * The mock terminal's Express app: the Terminal API on `/sync` and the page.
 */
function createApp() {
    const app = express();
    app.use(express.json());
    app.use((err, req, res, next) => {
        // Return a invalidJsonObject response when `express.json()` throws an error.
        if (err instanceof SyntaxError) {
            const invalidJsonObjectResponse = payloadService.getResponseByPrefix("invalidJsonObjectNotification");
            userInteractionService.setLastResponse(invalidJsonObjectResponse);
            messageLog.complete(messageLog.add(null), invalidJsonObjectResponse);
            res.status(200).send(invalidJsonObjectResponse);
            return;
        }

        next(err);
    });

    app.use(express.static(paths.publicDir()));

    app.engine("hbs", handlebars({
            extname: "hbs",
            defaultLayout: "layout",
            layoutsDir: path.join(paths.viewsDir(), "layouts"),
            helpers: {
                toUpperCase: function (string) {
                    return string.charAt(0).toUpperCase() + string.slice(1);
                },
                isEqual: function (stringA, stringB) {
                    return stringA === stringB;
                }
            }
        })
    );

    app.set("view engine", "hbs");
    app.set("views", paths.viewsDir());

    app.use("/", defaultRoutes);
    app.use("/user-interaction", userInteractionRoutes);
    return app;
}

function listen(app, port, host) {
    return new Promise((resolve, reject) => {
        const server = app.listen(port, host);
        server.once("listening", () => resolve(server));
        server.once("error", reject);
    });
}

/**
 * Starts the mock terminal. If `port` is taken, tries the next ones, up to `portAttempts` in all.
 * @param {Object} [options]
 * @param {Number} [options.port] - 3000 by default.
 * @param {Number} [options.portAttempts] - How many ports to try, counting up; 1 by default.
 * @param {String} [options.host] - All interfaces by default, so a POS on the network can connect.
 * @returns {Promise<{ port: Number, server: import('http').Server, close: () => Promise<void> }>}
 */
async function startServer({ port = 3000, portAttempts = 1, host } = {}) {
    const app = createApp();
    let lastError;
    for (let attempt = 0; attempt < Math.max(1, portAttempts); attempt++) {
        try {
            const server = await listen(app, port + attempt, host);
            const actualPort = server.address().port;
            return {
                port: actualPort,
                server,
                close: () => new Promise((resolve) => server.close(() => resolve())),
            };
        } catch (error) {
            lastError = error;
            if (error.code !== "EADDRINUSE") {
                throw error;
            }
        }
    }
    throw lastError;
}

module.exports = { createApp, startServer };
