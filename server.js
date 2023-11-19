// Подключение необходимых модулей и библиотек
const express = require('express');
const admin = require('firebase-admin');
const db = require('./config/database');
const morgan = require('morgan');
const logger = require('./logger');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 80;

const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined', { stream: { write: message => logger.info(message) } }));

function errorHandler(err, req, res, next) {
  logger.error(err.stack); // Логируем стек ошибки

  // Определяем HTTP статус код ответа
  const statusCode = err.statusCode || 500;

  // Отправляем ответ с сообщением об ошибке
  res.status(statusCode).json({
    error: {
      message: err.message,
      status: statusCode,
      timestamp: new Date().toISOString(),
    },
  });
}

function executeQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, results) => {
      if (err) {
        logger.error('Ошибка при выполнении запроса к базе данных:', err.message);
        reject(err);
      } else {
        resolve(results);
      }
    });
  });
}

app.get('/services', async (req, res) => {
  try {
    const sql = 'SELECT service_name FROM services';
    const results = await executeQuery(sql);

    const serviceNames = results.map(result => result.service_name);
    res.status(200).json(serviceNames);
  } catch (err) {
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/paymentmethods', async (req, res) => {
  try {
    const sql = 'SELECT payment FROM paymentmethod';
    const results = await executeQuery(sql);

    const paymentMethods = results.map(result => result.payment);
    res.status(200).json(paymentMethods);
  } catch (err) {
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/employees', async (req, res) => {
  try {
    const sql = 'SELECT id, full_name FROM employees';
    const results = await executeQuery(sql);
    res.status(200).json(results);
  } catch (err) {
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/responsibles', async (req, res) => {
  try {
    const sql = 'SELECT full_name FROM responsibles';
    const results = await executeQuery(sql);
    const employeeNames = results.map(result => result.full_name);
    res.status(200).json(employeeNames);
  } catch (err) {
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/task_employees', async (req, res) => {
  try {
    const sql = 'SELECT * FROM task_employees';
    const results = await executeQuery(sql);
    const employeeNames = results.map(result => result.full_name);
    res.status(200).json(employeeNames);
  } catch (err) {
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/clients', async (req, res) => {
  try {
    const sql = 'SELECT * FROM clients';
    const results = await executeQuery(sql);
    res.status(200).json(results);
  } catch (err) {
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/tasks', async (req, res) => {
  try {
    let sql = 'SELECT * FROM tasks';
    const params = [];

    if (req.query.start_date) {
      sql += ' WHERE DATE(start_date) = ?';
      params.push(req.query.start_date);
    }

    const results = await executeQuery(sql, params);
    res.status(200).json(results);
  } catch (err) {
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/task-dates', async (req, res) => {
  try {
    const sql = 'SELECT DISTINCT DATE(start_date) AS task_date FROM tasks';
    const results = await executeQuery(sql);
    const taskDates = results.map(result => result.task_date);
    res.status(200).json(taskDates);
  } catch (err) {
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});


app.post('/tasks', (req, res) => {
  try {
    const { status, service, payment, cost, start_date, end_date, start_time, end_time, responsible, fullname_client, address_client, phone, description, employees } = req.body;

    // Проверка входных данных
    if (!status || !service || !payment || !cost || !start_date || !end_date || !start_time || !end_time || !responsible || !fullname_client || !address_client || !phone || !description) {
      logger.error('Ошибка: Не все поля задачи заполнены');
      return res.status(400).json({ error: 'Не все поля задачи заполнены' });
    }

    const taskSql = `
    INSERT INTO tasks
    (status, service, payment, cost, start_date, end_date, start_time, end_time, responsible, fullname_client, address_client, phone, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

    db.query(taskSql, [status, service, payment, cost, start_date, end_date, start_time, end_time, responsible, fullname_client, address_client, phone, description], (err, taskResult) => {
      if (err) {
        logger.error('Ошибка при добавлении задачи:', err.message);
        return res.status(500).json({ error: 'Ошибка при добавлении задачи' });
      }

      const taskId = taskResult.insertId;
      
      if (employees && employees.length) {
        const checkEmployeesExistenceSql = 'SELECT id FROM employees WHERE id IN (?)';

        db.query(checkEmployeesExistenceSql, [employees], (err, results) => {
          if (err) {
            logger.error('Ошибка при проверке существования сотрудников:', err.message);
            return res.status(500).json({ error: 'Ошибка при проверке существования сотрудников' });
          }

          if (results.length !== employees.length) {
            return res.status(400).json({ error: 'Один или несколько предоставленных ID сотрудников не существуют' });
          }

          const employeeTasksSql = 'INSERT INTO task_employees (task_id, employee_id) VALUES ?';
          const employeeTasksValues = employees.map(id => [taskId, id]);

          db.query(employeeTasksSql, [employeeTasksValues], (err) => {
            if (err) {
              logger.error('Ошибка при добавлении сотрудников к задаче:', err.message);
              db.query('DELETE FROM tasks WHERE id = ?', [taskId], () => {
                return res.status(500).json({ error: 'Ошибка при добавлении сотрудников к задаче' });
              });
            } else {
              res.status(201).json({ message: 'Задача и связи с участниками успешно созданы', task_id: taskId });
            }
          });

        });
        db.query('SELECT task_id, COUNT(employee_id) as employee_count FROM task_employees GROUP BY task_id', (err, results) => {
          if (err) {
            // Обработка ошибки
            logger.error('Ошибка при подсчете участников для каждого task_id:', err.message);
          } else {
            // Обработка результатов
            results.forEach((row) => {
              logger.info(`Задача ${row.task_id} имеет ${row.employee_count} участников`);
              // Здесь можно обновить соответствующую запись в таблице tasks, если это необходимо
            });
          }
        });
        db.query('SELECT task_id, COUNT(employee_id) as employee_count FROM task_employees GROUP BY task_id', (err, results) => {
          if (err) {
            logger.error('Ошибка при подсчете участников:', err.message);
            // Обработка ошибки, возможно, отправка ответа о неудаче
          } else {
            // Обновляем количество участников в таблице tasks
            results.forEach((row) => {
              db.query('UPDATE tasks SET employees = ? WHERE id = ?', [row.employee_count, row.task_id], (updateErr) => {
                if (updateErr) {
                  logger.error('Ошибка при обновлении количества участников:', updateErr.message);
                  // Обработка ошибки, возможно, отправка ответа о неудаче
                } else {
                  logger.info(`Количество участников для задачи ${row.task_id} обновлено: ${row.employee_count}`);
                  // Возможно, отправка подтверждающего ответа
                }
              });
            });
          }
        });
      } else {
        logger.info('Задача добавлена без сотрудников');
        res.status(201).json({ message: 'Задача успешно добавлена без участников', task_id: taskId });
      }
    });
  } catch (err) {
    logger.error('Ошибка при добавлении задачи:', err.message);
    res.status(500).json({ error: 'Ошибка на сервере' });
  }
});


app.put('/tasks/:taskId', (req, res) => {
  const { taskId } = req.params;
  const { status } = req.body;

  // SQL-запрос для обновления статуса задачи
  const sql = 'UPDATE tasks SET status = ? WHERE id = ?';

  // Выполняем SQL-запрос с переданными параметрами
  db.query(sql, [status, taskId], (err, result) => {
    if (err) {
      logger.error('Ошибка при обновлении статуса задачи:', err.message);
      return res.status(500).json({ error: 'Ошибка при обновлении статуса задачи' });
    }

    // Если статус задачи успешно обновлен, возвращаем успешный ответ
    res.status(200).json({ message: 'Статус задачи успешно обновлен' });
  });
});

app.put('/clients/:clientId', (req, res) => {
  const { clientId } = req.params;
  const { full_name, phone_number, address } = req.body;

  if (!full_name || !phone_number) {
    return res.status(400).json({ error: 'ФИО и номер телефона обязательны для обновления.' });
  }

  const sql = 'UPDATE clients SET full_name = ?, phone_number = ?, address = ? WHERE id = ?';
  db.query(sql, [full_name, phone_number, address, clientId], (err, result) => {
    if (err) {
      logger.error('Ошибка при обновлении клиента:', err.message);
      return res.status(500).json({ error: 'Ошибка при обновлении клиента' });
    }

    res.status(200).json({ message: 'Данные клиента успешно обновлены' });
  });
});

app.delete('/clients/:clientId', (req, res) => {
  const { clientId } = req.params;

  const sql = 'DELETE FROM clients WHERE id = ?';
  db.query(sql, [clientId], (err, result) => {
    if (err) {
      logger.error('Ошибка при удалении клиента:', err.message);
      return res.status(500).json({ error: 'Ошибка при удалении клиента' });
    }

    res.status(200).json({ message: 'Клиент успешно удален' });
  });
});

// Эндпоинт для добавления нового клиента
app.post('/clients', (req, res) => {
  // Извлекаем данные клиента из тела запроса
  const { full_name, phone_number, address } = req.body;

  // Проверяем, что все необходимые данные были предоставлены
  if (!full_name || !phone_number) {
    return res.status(400).json({ error: 'ФИО и номер телефона являются обязательными полями.' });
  }

  // SQL-запрос для вставки нового клиента в таблицу "clients"
  const sql = 'INSERT INTO clients (full_name, phone_number, address) VALUES (?, ?, ?)';

  // Выполняем SQL-запрос
  db.query(sql, [full_name, phone_number, address], (err, result) => {
    if (err) {
      logger.error('Ошибка при добавлении клиента в базу данных:', err.message);
      return res.status(500).json({ error: 'Ошибка при добавлении клиента' });
    }

    // Если клиент успешно добавлен, возвращаем успешный ответ
    res.status(201).json({ message: 'Клиент успешно добавлен', client_id: result.insertId });
  });
});

// Эндпоинт для добавления сотрудников к задаче
app.post('/tasks/:taskId/employees', (req, res) => {
  const { taskId } = req.params;
  const { employees } = req.body; // Массив ID сотрудников

  if (!employees || !employees.length) {
    return res.status(400).json({ error: 'Необходимо предоставить массив ID сотрудников.' });
  }
  logger.info(employees);
  // Подготовим запросы для добавления каждого сотрудника к задаче
  const insertValues = employees.map(employeeId => [parseInt(taskId, 10), parseInt(employeeId, 10)]);

  const sql = 'INSERT INTO task_employees (task_id, employee_id) VALUES ?';

  db.query(sql, [insertValues], (err, result) => {
    if (err) {
      logger.error('Ошибка при добавлении сотрудников к задаче:', err.message);
      return res.status(500).json({ error: 'Ошибка при добавлении сотрудников к задаче' });
    }

    res.status(201).json({ message: 'Сотрудники успешно добавлены к задаче' });
  });
});


// Маршрут для добавления нового клиента
app.post('/add-client', (req, res) => {

  const fullUrl = req.protocol + '://' + req.get('host') + req.originalUrl;
  logger.info('Полный URL-адрес запроса:', fullUrl);
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
      logger.error('Ошибка при добавлении клиента в базу данных:', err.message);
      return res.status(500).json({ error: 'Ошибка при добавлении клиента' });
    }

    // Если клиент успешно добавлен, возвращаем успешный ответ
    res.status(201).json({ message: 'Клиент успешно добавлен', client_id: result.insertId });
  });
});

app.get('/', (req, res) => {
  res.send('Добро пожаловать на сервер!');
});

app.use(errorHandler);

app.listen(port, () => {
  logger.info(`Сервер запущен на порту ${port}`);
});

app.on('error', (err) => {
  logger.error('Ошибка запуска сервера: ' + err.message);
  process.exit(1);
});