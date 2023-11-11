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

app.get('/services', (req, res) => {
  const sql = 'SELECT service_name FROM services'; // SQL-запрос для извлечения данных из таблицы services

  db.query(sql, (err, results) => {
    if (err) {
      console.error('Ошибка при выполнении запроса к базе данных:', err.message);
      return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }

    const serviceNames = results.map(result => result.service_name);
    res.status(200).json(serviceNames);
  });
});

app.get('/paymentmethods', (req, res) => {
  const sql = 'SELECT payment FROM paymentmethod'; // SQL-запрос для извлечения данных из таблицы paymentmethod

  db.query(sql, (err, results) => {
    if (err) {
      console.error('Ошибка при выполнении запроса к базе данных:', err.message);
      return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }

    const paymentMethods = results.map(result => result.payment);
    res.status(200).json(paymentMethods);
  });
});

app.get('/employees', (req, res) => {
  const sql = 'SELECT full_name FROM employees'; // SQL-запрос для извлечения данных из таблицы employees

  db.query(sql, (err, results) => {
    if (err) {
      console.error('Ошибка при выполнении запроса к базе данных:', err.message);
      return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }

    const employeeNames = results.map(result => result.full_name);
    res.status(200).json(employeeNames);
  });
});

app.get('/clients', (req, res) => {
  const sql = 'SELECT full_name, address, phone_number FROM clients'; // SQL-запрос для извлечения данных из таблицы clients

  db.query(sql, (err, results) => {
    if (err) {
      console.error('Ошибка при выполнении запроса к базе данных:', err.message);
      return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }

    const clientData = results.map(result => ({
      full_name: result.full_name,
      address: result.address,
      phone_number: result.phone_number
    }));
    res.status(200).json(clientData);
  });
});

app.get('/tasks', (req, res) => {
  let sql = 'SELECT * FROM tasks';
  const params = [];

  // Если в запросе указан параметр date, фильтруем задачи по этой дате
  if (req.query.date) {
    sql += ' WHERE DATE(start_date) = ?';
    params.push(req.query.date);
  }

  db.query(sql, params, (err, results) => {
    if (err) {
      console.error('Ошибка при выполнении запроса к базе данных:', err.message);
      return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }

    res.status(200).json(results);
  });
});

app.get('/task-dates', (req, res) => {
  const sql = 'SELECT DISTINCT DATE(start_date) AS task_date FROM tasks';
  db.query(sql, (err, results) => {
    if (err) {
      console.error('Ошибка при выполнении запроса к базе данных:', err.message);
      return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }

    // Форматируем результат в массив дат
    const taskDates = results.map(result => result.task_date);
    res.status(200).json(taskDates);
  });
});


app.post('/tasks', (req, res) => {
  const { status, service, payment, cost, start_date, end_date, start_time, end_time, responsible, employees, fullname_client, address_client, phone, description } = req.body;

  console.log('Поля запроса:', {
    status,
    service,
    payment,
    cost,
    start_date,
    end_date,
    start_time,
    end_time,
    responsible,
    employees,
    fullname_client,
    address_client,
    phone,
    description
  });

  const emptyFields = [];

  if (!status) emptyFields.push('status');
  if (!service) emptyFields.push('Услуга');
  if (!payment) emptyFields.push('Способ оплаты');
  if (!cost) emptyFields.push('Стоимость услуги');
  if (!start_date) emptyFields.push('Дата начала');
  if (!end_date) emptyFields.push('Дата окончания');
  if (!start_time) emptyFields.push('Дедлайн');
  if (!end_time) emptyFields.push('Время');
  if (!responsible) emptyFields.push('Ответственный');
  if (!employees) emptyFields.push('Участники');
  if (!fullname_client) emptyFields.push('ФИО клиента');
  if (!address_client) emptyFields.push('Адрес клиента');
  if (!phone) emptyFields.push('Номер телефона клиента');
  if (!description) emptyFields.push('Описание');
  
  if (emptyFields.length > 0) {
    console.log('Ошибка 400: Отсутствующие или некорректные поля:', emptyFields);
    return res.status(400).json({ error: 'Не все поля задачи заполнены', missingFields: emptyFields });
  }
  const sql = 'INSERT INTO tasks (status, service, payment, cost, start_date, end_date, start_time, end_time, responsible, employees, fullname_client, address_client, phone, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

  db.query(sql, [status, service, payment, cost, start_date, end_date, start_time, end_time, responsible, employees, fullname_client, address_client, phone, description], (err, result) => {
    if (err) {
      console.error('Ошибка при добавлении задачи в базу данных:', err.message);
      return res.status(500).json({ error: 'Ошибка при добавлении задачи' });
    }

    console.log('Задача успешно добавлена:', result);
    res.status(201).json({ message: 'Задача успешно добавлена', task_id: result.insertId });
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