// Подключение необходимых модулей и библиотек
const express = require('express');
const bodyParser = require('body-parser');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const admin = require('firebase-admin');

const app = express();
const port = 80;

const db = mysql.createPool({
  host: 'bprof.dens04.beget.tech',
  user: 'dens04_fred',
  password: 'AdminTest1',
  database: 'dens04_fred',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

db.getConnection((err, connection) => {
  if (err) {
    console.error('Ошибка подключения к базе данных: ' + err.message);
  } else {
    console.log('Успешное подключение к базе данных');
  }
  
});

db.on('error', (err) => {
  console.error('Ошибка MySQL: ' + err.message);

  if (err.code === 'PROTOCOL_CONNECTION_LOST') {
    console.error('Соединение с базой данных потеряно');
    handleDatabaseConnectionError(err);
  } else if (err.code === 'ER_CON_COUNT_ERROR') {
    console.error('Слишком много соединений с базой данных');
    handleDatabaseConnectionError(err);
  } else {
    handleDatabaseError(err);
  }
});

function handleDatabaseConnectionError(err) {
  db.connect((reconnectError) => {
    if (reconnectError) {
      console.error('Ошибка переподключения к базе данных: ' + reconnectError.message);
      process.exit(1);
    }
    console.log('Успешное переподключение к базе данных');
  });
}

function handleDatabaseError(err) {
  console.error('Ошибка базы данных: ' + err.message);
}

const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

function sendPushNotification(deviceToken, title, body) {
  const message = {
    token: deviceToken,
    notification: {
      title: title,
      body: body,
    },
  };

  admin.messaging()
    .send(message)
    .then((response) => {
      console.log('Пуш-уведомление успешно отправлено:', response);
    })
    .catch((error) => {
      console.error('Ошибка при отправке пуш-уведомления:', error);
    });
}

app.use(bodyParser.json());

app.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Введите логин и пароль' });
  }

  const sql = 'SELECT * FROM users WHERE username = ?';
  db.query(sql, [username], (err, results) => {
    if (err) {
      console.error('Ошибка при выполнении запроса к базе данных:', err.message);
      return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }

    if (results.length === 0) {
      return res.status(401).json({ error: 'Пользователь не найден' });
    }

    const user = results[0];

    bcrypt.compare(password, user.password, (compareErr, isMatch) => {
      if (compareErr) {
        console.error('Ошибка при сравнении паролей:', compareErr.message);
        return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
      }

      if (!isMatch) {
        return res.status(401).json({ error: 'Неправильный пароль' });
      }

      res.status(200).json({ message: 'Вход выполнен успешно', user: { id: user.id, username: user.username } });
    });
  });
});


// Маршрут для добавления нового клиента
app.post('/add-client', (req, res) => {

  const fullUrl = req.protocol + '://' + req.get('host') + req.originalUrl;
  console.log('Полный URL-адрес запроса:', fullUrl);
  // Извлекаем данные клиента из тела запроса
  const { full_name, phone_number, email, address, source, comment } = req.body;

  // Проверяем, что все необходимые данные были предоставлены
  if (!full_name || !phone_number || !email || !address || !source || !comment) {
    return res.status(400).json({ error: 'Все поля клиента должны быть заполнены' });
  }

  // SQL-запрос для вставки нового клиента в таблицу "clients"
  const sql = 'INSERT INTO clients (full_name, phone_number, email, address, source, comment) VALUES (?, ?, ?, ?, ?, ?)';

  // Выполняем SQL-запрос
  db.query(sql, [full_name, phone_number, email, address, source, comment], (err, result) => {
    if (err) {
      console.error('Ошибка при добавлении клиента в базу данных:', err.message);
      return res.status(500).json({ error: 'Ошибка при добавлении клиента' });
    }

    // Если клиент успешно добавлен, возвращаем успешный ответ
    res.status(201).json({ message: 'Клиент успешно добавлен', client_id: result.insertId });
  });
});

app.get('/', (req, res) => {
  res.send('Добро пожаловать на сервер!');
});

app.listen(port, () => {
  console.log(`Сервер запущен на порту ${port}`);
});

app.on('error', (err) => {
  console.error('Ошибка запуска сервера: ' + err.message);
  process.exit(1);
});
