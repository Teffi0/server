const mysql = require('mysql2');
const morgan = require('morgan');
const logger = require('./logger');

const port = process.env.PORT || 80;

require('dotenv').config();

const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
};

const db = mysql.createPool(dbConfig);

db.getConnection((err, connection) => {
    if (err) {
        logger.error('Ошибка подключения к базе данных: ' + err.message);
    } else {
        logger.info('Успешное подключение к базе данных');
        connection.release();
    }

});

db.on('error', (err) => {
    logger.error('Ошибка MySQL: ' + err.message);

    if (err.code === 'PROTOCOL_CONNECTION_LOST') {
        logger.error('Соединение с базой данных потеряно');
        handleDatabaseConnectionError(err);
    } else if (err.code === 'ER_CON_COUNT_ERROR') {
        logger.warn('Слишком много соединений с базой данных');
        handleDatabaseConnectionError(err);
    } else {
        handleDatabaseError(err);
    }
});


function handleDatabaseConnectionError(err) {
    db.connect((reconnectError) => {
        if (reconnectError) {
            logger.error('Ошибка переподключения к базе данных: ' + reconnectError.message);
            process.exit(1);
        }
        logger.info('Успешное переподключение к базе данных');
    });
}

function handleDatabaseError(err) {
    logger.error('Ошибка базы данных: ' + err.message);
}

module.exports = db;