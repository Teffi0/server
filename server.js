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
  logger.error(err.stack);

  const statusCode = err.statusCode || 500;

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
    db.getConnection((err, connection) => {
      if (err) {
        logger.error('Ошибка получения соединения из пула:', err.message);
        reject(err);
        return;
      }
      connection.query(sql, params, (queryErr, results) => {
        connection.release(); // Освобождаем соединение в любом случае после запроса
        if (queryErr) {
          logger.error('Ошибка при выполнении запроса к базе данных:', queryErr.message);
          reject(queryErr);
        } else {
          resolve(results);
        }
      });
    });
  });
}

app.get('/services', async (req, res) => {
  try {
    // Используем * для выбора всех полей из таблицы services
    const sql = 'SELECT * FROM services';
    const results = await executeQuery(sql);

    // Передаём в ответ весь массив результатов
    res.status(200).json(results);
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

// Этот маршрут получает черновик задачи по её ID
app.get('/tasks/draft/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const sql = 'SELECT * FROM tasks WHERE id = ? AND status = "черновик"';
    const results = await executeQuery(sql, [taskId]);

    if (results.length === 0) {
      return res.status(404).json({ error: 'Черновик не найден' });
    }

    res.status(200).json(results[0]);
  } catch (err) {
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});


app.get('/task-dates', async (req, res) => {
  try {
    // Запрос для получения дат и статусов задач
    const sql = `
      SELECT 
        DATE(start_date) AS task_date, 
        status 
      FROM tasks
      WHERE status IN ('новая', 'в процессе')`;

    const results = await executeQuery(sql);

    // Структурирование результатов в объект, где ключами будут даты, а значениями - статусы задач
    const taskDates = results.reduce((acc, result) => {
      // Форматируем дату в строку
      const formattedDate = result.task_date.toISOString().split('T')[0];

      if (!acc[formattedDate]) {
        acc[formattedDate] = result.status;
      }

      return acc;
    }, {});

    res.status(200).json(taskDates);
  } catch (err) {
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});


app.get('/inventory', async (req, res) => {
  try {
    const sql = 'SELECT * FROM inventory';
    const results = await executeQuery(sql);
    res.status(200).json(results);
  } catch (err) {
    logger.error('Ошибка при получении инвентаря:', err.message);
    res.status(500).json({ error: 'Ошибка при получении инвентаря' });
  }
});


app.get('/task-participants/:taskId', (req, res) => {
  const { taskId } = req.params;
  const query = `
    SELECT e.id, e.full_name
    FROM employees e
    INNER JOIN task_employees te ON e.id = te.employee_id
    WHERE te.task_id = ?
  `;

  db.query(query, [taskId], (err, results) => {
    if (err) {
      console.error('Ошибка при выполнении запроса:', err.message);
      res.status(500).send('Ошибка сервера при получении участников задачи');
    } else {
      res.status(200).json(results);
    }
  });
});


app.post('/tasks/:taskId/services', async (req, res) => {
  const { taskId } = req.params;
  const { services } = req.body;

  if (!services || !services.length) {
    return res.status(400).json({ error: 'Необходимо предоставить массив ID услуг.' });
  }

  try {
    const insertValues = services.map(serviceId => [parseInt(taskId, 10), parseInt(serviceId, 10)]);
    const sql = 'INSERT INTO task_services (task_id, service_id) VALUES ?';

    await executeQuery(sql, [insertValues]);
    res.status(201).json({ message: 'Услуги успешно добавлены к задаче' });
  } catch (err) {
    logger.error('Ошибка при добавлении услуг к задаче:', err.message);
    res.status(500).json({ error: 'Ошибка при добавлении услуг к задаче' });
  }
});

app.get('/tasks/:taskId/services', async (req, res) => {
  const { taskId } = req.params;

  try {
    const sql = `
      SELECT s.* FROM services s
      INNER JOIN task_services ts ON s.id = ts.service_id
      WHERE ts.task_id = ?
    `;

    const services = await executeQuery(sql, [taskId]);
    res.status(200).json(services);
  } catch (err) {
    logger.error('Ошибка при получении услуг задачи:', err.message);
    res.status(500).json({ error: 'Ошибка при получении услуг задачи' });
  }
});


app.post('/tasks', async (req, res) => {
  try {
    const {
      status, service, payment, cost, start_date, end_date, start_time,
      end_time, responsible, fullname_client, address_client, phone,
      description, employees, services
    } = req.body;

    // Проверка обязательных полей
    if (status !== 'черновик' && (!service || !payment || !cost || !start_date || !end_date || !start_time || !end_time || !responsible || !fullname_client || !address_client || !phone || !description)) {
      logger.error('Ошибка: Не все поля задачи заполнены');
      return res.status(400).json({ error: 'Не все поля задачи заполнены' });
    }

    // SQL запрос для добавления задачи
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
            logger.error('Ошибка при подсчете участников:', err.message);
          } else {
            results.forEach((row) => {
              db.query('UPDATE tasks SET employees = ? WHERE id = ?', [row.employee_count, row.task_id], (updateErr) => {
                if (updateErr) {
                  logger.error('Ошибка при обновлении количества участников:', updateErr.message);
                } else {
                  logger.info(`Количество участников для задачи ${row.task_id} обновлено: ${row.employee_count}`);
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

app.post('/tasks/:taskId/inventory', async (req, res) => {
  const { taskId } = req.params;
  const { inventory } = req.body;

  if (!inventory || !inventory.length) {
    return res.status(400).json({ error: 'Необходимо предоставить массив инвентаря.' });
  }

  db.getConnection((connErr, connection) => {
    if (connErr) {
      logger.error('Ошибка получения соединения из пула:', connErr.message);
      return res.status(500).json({ error: 'Ошибка при подключении к базе данных.' });
    }

    connection.beginTransaction((transactionErr) => {
      if (transactionErr) {
        connection.release();
        logger.error('Ошибка при начале транзакции:', transactionErr.message);
        return res.status(500).json({ error: 'Ошибка при начале транзакции.' });
      }

      try {
        // Выполняем запросы здесь, используя объект соединения, например:
        // connection.query(...)
        // ...

        // После всех запросов фиксируем транзакцию
        connection.commit((commitErr) => {
          if (commitErr) {
            throw commitErr; // Сгенерирует ошибку и перейдет к блоку catch
          }
          connection.release(); // Не забудь освободить соединение после завершения!
          res.status(201).json({ message: 'Инвентарь успешно добавлен и обновлен.' });
        });
      } catch (error) {
        // В случае ошибки откатываем транзакцию
        connection.rollback(() => {
          connection.release(); // Освобождаем соединение
          res.status(500).json({ error: 'Ошибка при добавлении инвентаря.' });
        });
      }
    });
  });
});

app.post('/services/names', async (req, res) => {
  try {
    const serviceIds = req.body.ids;

    // Проверяем, что serviceIds - это массив чисел
    if (!Array.isArray(serviceIds) || !serviceIds.every(id => typeof id === 'number')) {
      return res.status(400).json({ error: 'ids должен быть массивом чисел' });
    }

    // Создаем строку для запроса с плейсхолдерами
    const placeholders = serviceIds.map(() => '?').join(',');
    const sql = `SELECT id, service_name FROM services WHERE id IN (${placeholders})`;

    const results = await executeQuery(sql, serviceIds);

    // Проверяем, что каждый ID нашёл соответствие
    const services = serviceIds.map(id =>
      results.find(service => service.id === id) || { id, service_name: 'Услуга не найдена' }
    );

    res.status(200).json(services);
  } catch (err) {
    logger.error('Ошибка при получении названий услуг:', err.message);
    res.status(500).json({ error: 'Ошибка при получении названий услуг' });
  }
});


app.put('/tasks/:taskId', async (req, res) => {
  const { taskId } = req.params;
  const {
    status,
    service,
    payment,
    cost,
    start_date,
    end_date,
    start_time,
    end_time,
    responsible,
    fullname_client,
    address_client,
    phone,
    description,
    employees,
    services
  } = req.body;

  if (status === "новая") {
    // Если в теле запроса только статус, обновляем только его
    try {
      const sql = 'UPDATE tasks SET status = ? WHERE id = ?';
      await executeQuery(sql, [status, taskId]);
      res.status(200).json({ message: 'Статус задачи успешно обновлен.' });
    } catch (error) {
      logger.error('Ошибка при обновлении статуса задачи:', error.message);
      res.status(500).json({ error: 'Ошибка при обновлении статуса задачи.' });
    }
  } else {
    // Начинаем транзакцию
    db.getConnection((connErr, connection) => {
      if (connErr) {
        logger.error('Ошибка получения соединения:', connErr.message);
        return res.status(500).json({ error: 'Ошибка при подключении к базе данных.' });
      }

      connection.beginTransaction(async (transactionErr) => {
        if (transactionErr) {
          connection.release();
          logger.error('Ошибка при начале транзакции:', transactionErr.message);
          return res.status(500).json({ error: 'Ошибка при начале транзакции.' });
        }

        try {
          // Обновление основных данных задачи
          const updateTaskSql = `
          UPDATE tasks SET
            status = ?, service = ?, payment = ?, cost = ?, 
            start_date = ?, end_date = ?, start_time = ?, 
            end_time = ?, responsible = ?, fullname_client = ?, 
            address_client = ?, phone = ?, description = ?
          WHERE id = ?;
        `;
          await executeQuery(updateTaskSql, [
            status, service, payment, cost, start_date, end_date, start_time,
            end_time, responsible, fullname_client, address_client, phone,
            description, taskId
          ]);

          if (employees) {
            const employeeIds = employees.split(',').map(id => parseInt(id.trim(), 10));
            const deleteOldLinksSql = 'DELETE FROM task_employees WHERE task_id = ?';
            await executeQuery(deleteOldLinksSql, [taskId]);
      
            const insertNewLinksSql = 'INSERT INTO task_employees (task_id, employee_id) VALUES ?';
            const newLinksValues = employeeIds.map(employeeId => [taskId, employeeId]);
            await executeQuery(insertNewLinksSql, [newLinksValues]);

            db.query('SELECT task_id, COUNT(employee_id) as employee_count FROM task_employees GROUP BY task_id', (err, results) => {
              if (err) {
                logger.error('Ошибка при подсчете участников:', err.message);
              } else {
                results.forEach((row) => {
                  db.query('UPDATE tasks SET employees = ? WHERE id = ?', [row.employee_count, row.task_id], (updateErr) => {
                    if (updateErr) {
                      logger.error('Ошибка при обновлении количества участников:', updateErr.message);
                    } else {
                      logger.info(`Количество участников для задачи ${row.task_id} обновлено: ${row.employee_count}`);
                    }
                  });
                });
              }
            });
          }

          console.log(status, employees);
          // Удаление существующих связей услуг и задачи
          const deleteExistingServicesSql = 'DELETE FROM task_services WHERE task_id = ?';
          await executeQuery(deleteExistingServicesSql, [taskId]);

          // Добавление новых услуг, если они предоставлены
          if (services && services.length) {
            const insertServicesSql = 'INSERT INTO task_services (task_id, service_id) VALUES ?';
            const servicesValues = services.map(serviceId => [taskId, serviceId]);
            await executeQuery(insertServicesSql, [servicesValues]);
          }

          // Подтверждение транзакции
          connection.commit((commitErr) => {
            if (commitErr) throw commitErr;
            connection.release();
            res.status(200).json({ message: 'Задача успешно обновлена.' });
          });
        } catch (error) {
          // Откат транзакции в случае ошибки
          connection.rollback(() => {
            connection.release();
            logger.error('Ошибка при обновлении задачи:', error.message);
            res.status(500).json({ error: 'Ошибка при обновлении задачи.' });
          });
        }
      });
    });
  }
});


app.put('/tasks/:taskId/complete', (req, res) => {
  const { taskId } = req.params;
  const inventoryItems = req.body.inventory; // Предполагается, что в теле запроса передается массив объектов инвентаря

  if (!inventoryItems || !inventoryItems.length) {
    return res.status(400).json({ error: 'Необходимо предоставить данные об инвентаре.' });
  }

  db.getConnection((connErr, connection) => {
    if (connErr) {
      logger.error('Ошибка получения соединения из пула:', connErr.message);
      return res.status(500).json({ error: 'Ошибка при подключении к базе данных.' });
    }

    connection.beginTransaction(async (transactionErr) => {
      if (transactionErr) {
        connection.release();
        logger.error('Ошибка при начале транзакции:', transactionErr.message);
        return res.status(500).json({ error: 'Ошибка при начале транзакции.' });
      }

      try {
        // Обновляем статус задачи
        const updateTaskSql = 'UPDATE tasks SET status = "выполнено" WHERE id = ?';
        await new Promise((resolve, reject) => {
          connection.query(updateTaskSql, [taskId], (queryErr, results) => {
            if (queryErr) reject(queryErr);
            else resolve(results);
          });
        });

        // Вычитаем количество инвентаря
        for (const item of inventoryItems) {
          const updateInventorySql = 'UPDATE inventory SET quantity = GREATEST(0, quantity - ?) WHERE id = ?';
          await new Promise((resolve, reject) => {
            connection.query(updateInventorySql, [item.quantity, item.inventory_id], (queryErr, results) => {
              if (queryErr) reject(queryErr);
              else resolve(results);
            });
          });
        }

        connection.commit((commitErr) => {
          if (commitErr) {
            throw commitErr; // Сгенерирует ошибку и перейдет к блоку catch
          }
          connection.release(); // Освобождаем соединение после коммита
          res.status(200).json({ message: 'Задача выполнена и инвентарь обновлён' });
        });
      } catch (error) {
        // В случае ошибки откатываем транзакцию
        connection.rollback(() => {
          connection.release(); // Освобождаем соединение после отката
          logger.error('Ошибка при выполнении запросов, откатываем изменения:', error.message);
          res.status(500).json({ error: 'Ошибка при выполнении запросов, откатываем изменения' });
        });
      }
    });
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

app.post('/clients', (req, res) => {
  const { full_name, phone_number, address } = req.body;

  if (!full_name || !phone_number) {
    return res.status(400).json({ error: 'ФИО и номер телефона являются обязательными полями.' });
  }

  const sql = 'INSERT INTO clients (full_name, phone_number, address) VALUES (?, ?, ?)';

  db.query(sql, [full_name, phone_number, address], (err, result) => {
    if (err) {
      logger.error('Ошибка при добавлении клиента в базу данных:', err.message);
      return res.status(500).json({ error: 'Ошибка при добавлении клиента' });
    }

    res.status(201).json({ message: 'Клиент успешно добавлен', client_id: result.insertId });
  });
});

app.post('/tasks/:taskId/employees', (req, res) => {
  const { taskId } = req.params;
  const { employees } = req.body;

  if (!employees || !employees.length) {
    return res.status(400).json({ error: 'Необходимо предоставить массив ID сотрудников.' });
  }

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