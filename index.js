const { startServer } = require('./src/server');

const port = parseInt(process.env.PORT, 10) || 3000;

startServer({ port })
    .then(({ port }) => console.log(`Server started -> http://localhost:${port}`))
    .catch((error) => {
        console.error(`Could not start the mock terminal: ${error.message}`);
        process.exit(1);
    });
