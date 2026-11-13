const mysql = require('mysql2/promise');

// MySQL connection settings come from the environment only (see .env.example); credentials are
// never written into source. With nothing configured this module stays inert: isConfigured() is
// false and no pool is ever created, so the app and the test suite run cleanly without MySQL.
function settings() {
  return {
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE || 'netsvouch'
  };
}

function isConfigured() {
  const config = settings();
  return Boolean(config.host && config.user && typeof config.password === 'string');
}

let pool = null;
function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      ...settings(),
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });
  }
  return pool;
}

function notConfigured() {
  return Promise.reject(new Error('MySQL is not configured (set MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD)'));
}

module.exports = {
  isConfigured: isConfigured,
  query: function(sql, params) { return isConfigured() ? getPool().query(sql, params) : notConfigured(); },
  execute: function(sql, params) { return isConfigured() ? getPool().execute(sql, params) : notConfigured(); }
};
