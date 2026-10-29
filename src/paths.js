const path = require('path');

/**
 * Where the mock's files are: `public/` (page, payloads) and `src/views/`.
 * The repository root, unless MOCK_TERMINAL_ROOT says otherwise (the desktop app sets it to
 * its resources, where these files are packaged). Read when first needed, so it can be set
 * before the server starts.
 */
function root() {
    return process.env.MOCK_TERMINAL_ROOT || path.join(__dirname, '..');
}

module.exports = {
    publicDir: () => path.join(root(), 'public'),
    payloadsDir: () => path.join(root(), 'public', 'payloads'),
    viewsDir: () => path.join(root(), 'src', 'views'),
};
