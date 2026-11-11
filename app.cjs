/**
 * Startup file for cPanel "Setup Node.js App" (Phusion Passenger).
 * Passenger loads apps with require(), so this CommonJS file loads the ES-module server.
 * In cPanel set:  Application startup file = app.cjs
 */
import('./src/server.js').catch((err) => {
  console.error('Failed to start Epson Expert Connect API:', err);
  process.exit(1);
});
