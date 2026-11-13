const mysql = require('mysql2/promise');

// Create a connection pool to the NetsVouch MySQL database
const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: 'RP738964$',
  database: 'netsvouch',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Test the connection immediately
pool.getConnection()
  .then(connection => {
    console.log('✅ Successfully connected to the netsvouch MySQL database from Database/db.js.');
    connection.release();
  })
  .catch(err => {
    console.error('❌ FATAL ERROR: Failed to connect to MySQL database:', err.message);
  });

module.exports = pool;