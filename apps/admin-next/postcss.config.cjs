const path = require('node:path');

// Panda generates the Koi styles for the whole app. Absolute paths keep the
// config resolvable whichever directory the dev server starts in.
module.exports = {
  plugins: {
    '@pandacss/dev/postcss': {
      configPath: path.join(__dirname, 'panda.config.ts'),
      cwd: __dirname,
    },
  },
};
