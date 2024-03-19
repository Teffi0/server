const express = require('express');
const multer = require('multer');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const db = require('./config/database');
const morgan = require('morgan');
const logger = require('./logger');
const cors = require('cors');
const fs = require('fs');
const https = require('https');
require('dotenv').config();
import * as FirebaseService from "./FirebaseService";

const app = express();
const port = 443;

const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined', { stream: { write: message => logger.info(message) } }));
app.use(cors({
  origin: '*', // Разрешаем доступ с любого домена
  methods: ['GET', 'POST', 'DELETE', 'UPDATE', 'PUT', 'PATCH']
}));

const sslOptions = {
  key: fs.readFileSync('/etc/letsencrypt/live/isk-profi.store/privkey.pem'), // Проверь этот путь
  cert: fs.readFileSync('/etc/letsencrypt/live/isk-profi.store/fullchain.pem'), // И этот путь
};

app.get('/.well-known/acme-challenge/:content', (req, res) => {
  const { content } = req.params;
  // Убедись, что файл с таким именем существует в нужной директории, иначе возвращай ошибку 404
  const acmeChallengePath = path.join(__dirname, '.well-known', 'acme-challenge', content);
  if (fs.existsSync(acmeChallengePath)) {
    res.sendFile(acmeChallengePath);
  } else {
    res.status(404).send('Not Found');
  }
});

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

// Настройка хранения файлов Multer
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/') // Папка для сохранения файлов
  },
  filename: function (req, file, cb) {
    cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname))
  }
});

const upload = multer({ storage: storage });

app.post('/tasks/:taskId/photos', upload.array('photos', 20), async (req, res) => {
  const { taskId } = req.params;
  if (!req.files || req.files.length === 0) {
    return res.status(400).send('Не загружены файлы');
  }

  try {
    // Проверяем наличие существующих фотографий для задачи
    const existingPhotos = await executeQuery("SELECT * FROM task_photos WHERE task_id = ?", [taskId]);

    if (existingPhotos.length > 0) {
      // Удаляем существующие фотографии из файловой системы
      existingPhotos.forEach(photo => {
        const filePath = path.join(__dirname, photo.photo_url);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      });

      // Удаляем существующие фотографии из базы данных
      await executeQuery("DELETE FROM task_photos WHERE task_id = ?", [taskId]);
    }

    // Добавляем новые фотографии
    const photoUrls = req.files.map(file => ({
      url: `/uploads/${file.filename}`,
      uploadedAt: new Date().toISOString()
    }));

    const insertPromises = photoUrls.map(({ url, uploadedAt }) =>
      executeQuery("INSERT INTO task_photos (task_id, photo_url, uploaded_at) VALUES (?, ?, ?)", [taskId, url, uploadedAt])
    );

    await Promise.all(insertPromises);

    res.status(201).send('Фотографии успешно загружены');
  } catch (error) {
    logger.error('Ошибка при сохранении фотографий:', error);
    res.status(500).send('Ошибка при сохранении фотографий');
  }
});

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Маршрут для получения фотографий по задаче
app.get('/tasks/:taskId/photos', async (req, res) => {
  const { taskId } = req.params;

  try {
    const results = await executeQuery("SELECT * FROM task_photos WHERE task_id = ?", [taskId]);
    res.status(200).json(results);
  } catch (error) {
    logger.error('Ошибка при получении фотографий:', error);
    res.status(500).send('Ошибка при получении фотографий');
  }
});

// Эндпоинт для регистрации токена устройства
app.post('/registerPushToken', async (req, res) => {
  const { userId, token } = req.body;
  if (!userId || !token) {
    return res.status(400).send("Необходимы userId и token");
  }
  try {
    const sql = "INSERT INTO device_tokens (userId, token) VALUES (?, ?) ON DUPLICATE KEY UPDATE token = VALUES(token)";
    await executeQuery(sql, [userId, token]);
    res.status(200).send("Токен успешно зарегистрирован");
  } catch (error) {
    console.error("Ошибка при регистрации токена:", error);
    res.status(500).send("Ошибка сервера при регистрации токена");
  }
});

// Эндпоинт для отправки уведомлений всем устройствам
app.post('/sendNotifications', async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).send("Необходимо сообщение для отправки");
  }
  try {
    const tokensSql = "SELECT token FROM device_tokens";
    const tokens = await executeQuery(tokensSql);
    const notifications = tokens.map(({ token }) => ({
      to: token,
      sound: 'default',
      title: "Новое уведомление",
      body: message,
    }));

    // Здесь должна быть логика отправки уведомлений через Expo
    // Например, используя Expo Notifications API
    // await sendExpoNotifications(notifications);

    res.status(200).send("Уведомления успешно отправлены");
  } catch (error) {
    console.error("Ошибка при отправке уведомлений:", error);
    res.status(500).send("Ошибка сервера при отправке уведомлений");
  }
});

app.get('/tasks/:taskId/selected-inventory', async (req, res) => {
  const { taskId } = req.params;

  try {
    const sql = `
      SELECT ti.inventory_id, i.name, ti.quantity
      FROM task_inventory ti
      JOIN inventory i ON ti.inventory_id = i.id
      WHERE ti.task_id = ?
    `;
    const selectedItems = await executeQuery(sql, [taskId]);
    res.status(200).json(selectedItems);
  } catch (err) {
    logger.error('Ошибка при получении выбранного инвентаря:', err.message);
    res.status(500).json({ error: 'Ошибка при получении выбранного инвентаря' });
  }
});

app.put('/tasks/:taskId/inventory', async (req, res) => {
  const { taskId } = req.params;
  const newInventory = req.body.inventory;

  if (!newInventory) {
    return res.status(400).json({ error: 'Необходимо предоставить массив инвентаря.' });
  }

  db.getConnection((connErr, connection) => {
    if (connErr) {
      return res.status(500).json({ error: 'Ошибка при подключении к базе данных.' });
    }

    connection.beginTransaction(async (transactionErr) => {
      if (transactionErr) {
        connection.release();
        return res.status(500).json({ error: 'Ошибка при начале транзакции.' });
      }
      try {
        const oldInventoryData = await executeQuery('SELECT inventory_id, quantity FROM task_inventory WHERE task_id = ?', [taskId], connection);

        for (const oldItem of oldInventoryData) {
          await executeQuery('UPDATE inventory SET quantity = quantity + ? WHERE id = ?', [oldItem.quantity, oldItem.inventory_id], connection);
        }

        await executeQuery('DELETE FROM task_inventory WHERE task_id = ?', [taskId], connection);

        for (const newItem of newInventory) {
          await executeQuery('UPDATE inventory SET quantity = quantity - ? WHERE id = ?', [newItem.quantity, newItem.inventory_id], connection);
          await executeQuery('INSERT INTO task_inventory (task_id, inventory_id, quantity) VALUES (?, ?, ?)', [taskId, newItem.inventory_id, newItem.quantity], connection);
        }

        connection.commit(async (commitErr) => {
          if (commitErr) {
            connection.rollback(() => {
              connection.release();
              res.status(500).json({ error: 'Ошибка при фиксации транзакции.' });
            });
            return;
          }

          try {
            for (const newItem of newInventory) {
              await logInventoryChange(newItem.inventory_id, 1, `Обновлён инвентарь в задаче ${taskId}`);
            }
            res.status(200).json({ message: 'Инвентарь успешно обновлен.' });
          } catch (error) {
            res.status(500).json({ error: 'Ошибка при логировании изменений инвентаря.' });
          } finally {
            connection.release();
          }
        });
      } catch (error) {
        connection.rollback(() => {
          connection.release();
          res.status(500).json({ error: 'Ошибка при обновлении инвентаря.' });
        });
      }
    });
  });
});

app.post('/register', async (req, res) => {
  const { errors, isValid } = validateRegistrationInput(req.body);

  // Проверка валидности входных данных
  if (!isValid) {
    return res.status(400).json(errors);
  }

  const { username, password, full_name, phone_number, email, position, role } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Необходимо указать имя пользователя и пароль.' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    // Сохранение пользователя в базе данных
    const userSql = 'INSERT INTO users (username, password) VALUES (?, ?)';
    const userResult = await executeQuery(userSql, [username, hashedPassword]);
    const userId = userResult.insertId; // ID вставленного пользователя

    // Добавление в таблицу employees
    const employeeSql = 'INSERT INTO employees (id, full_name, phone_number, email, position) VALUES (?, ?, ?, ?, ?)';
    await executeQuery(employeeSql, [userId, full_name, phone_number, email, position]);

    // При необходимости добавление в таблицу responsibles
    if (role) {
      const responsibleSql = 'INSERT INTO responsibles (id, full_name, phone_number, email, position) VALUES (?, ?, ?, ?, ?)';
      await executeQuery(responsibleSql, [userId, full_name, phone_number, email, position]);
    }

    res.status(201).json({ message: 'Пользователь успешно зарегистрирован' });
  } catch (error) {
    // Убедитесь, что ваши логи пишутся в соответствующий файл или систему логирования
    console.error('Ошибка при регистрации пользователя:', error);
    res.status(500).json({ error: 'Ошибка при регистрации пользователя' });
  }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Необходимо указать имя пользователя и пароль.' });
  }

  try {
    const sql = 'SELECT * FROM users WHERE username = ?';
    const users = await executeQuery(sql, [username]);

    if (users.length === 0) {
      return res.status(401).json({ error: 'Неверное имя пользователя или пароль.' });
    }

    const user = users[0];
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({ error: 'Неверное имя пользователя или пароль.' });
    }

    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });

    res.json({ token: token, userId: user.id });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при аутентификации пользователя' });
  }
});

app.get('/user/:userId/data', async (req, res) => {
  const { userId } = req.params;

  try {
    const employeeData = await executeQuery("SELECT * FROM employees WHERE id = ?", [userId]);

    if (employeeData.length > 0) {
      // Отправляем данные сотрудника клиенту
      res.status(200).json({
        employee: employeeData[0]
      });
    } else {
      // Если данных нет, отправляем соответствующий ответ
      res.status(404).json({
        message: 'Данные сотрудника не найдены.'
      });
    }
  } catch (err) {
    logger.error('Ошибка при получении данных пользователя:', err.message);
    res.status(500).json({ error: 'Ошибка сервера при получении данных пользователя' });
  }
});

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

app.get('/servicesBase', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const countSql = 'SELECT COUNT(*) AS total FROM services';
    const [{ total }] = await executeQuery(countSql);
    const totalPages = Math.ceil(total / limit);

    const sql = 'SELECT * FROM services LIMIT ? OFFSET ?';
    const results = await executeQuery(sql, [limit, offset]);

    res.status(200).json({ services: results, totalPages: totalPages });
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
    const sql = 'SELECT * FROM employees';
    const results = await executeQuery(sql);
    res.status(200).json(results);
  } catch (err) {
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/employeesBase', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const employeeSql = 'SELECT * FROM employees';
    const employees = await executeQuery(employeeSql);
    const usersSql = 'SELECT id, username, password FROM users';
    const users = await executeQuery(usersSql);
    const responsiblesSql = 'SELECT id FROM responsibles';
    const responsibles = await executeQuery(responsiblesSql);

    const enhancedEmployees = employees.map(employee => {
      const user = users.find(u => u.id === employee.id); // Предполагаем, что связь через userId
      const isResponsible = responsibles.some(r => r.id === employee.id);
      return {
        ...employee,
        username: user ? user.username : '',
        password: user ? user.password : '',
        isResponsible: isResponsible ? 'Да' : 'Нет'
      };
    });

    const paginatedEmployees = enhancedEmployees.slice(offset, offset + limit);
    const totalPages = Math.ceil(enhancedEmployees.length / limit);

    res.status(200).json({ employees: paginatedEmployees, totalPages: totalPages });
  } catch (err) {
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/employees', async (req, res) => {
  const { full_name, phone_number, email, position, username, password } = req.body;

  if (!full_name || !phone_number || !username || !password) {
    return res.status(400).json({ error: 'ФИО, номер телефона, логин и пароль являются обязательными полями.' });
  }

  try {
    // Хеширование пароля
    const hashedPassword = await bcrypt.hash(password, 10);

    // Добавление пользователя в таблицу users
    const userSql = 'INSERT INTO users (username, password, created_at) VALUES (?, ?, NOW())';
    const userResult = await executeQuery(userSql, [username, hashedPassword]);
    const userId = userResult.insertId;

    // Добавление сотрудника в таблицу employees
    const employeeSql = 'INSERT INTO employees (id, full_name, phone_number, email, position) VALUES (?, ?, ?, ?, ?)';
    await executeQuery(employeeSql, [userId, full_name, phone_number, email, position]);
    await logEmployeeChange(userId, 1, 'Добавлен новый сотрудник');
    res.status(201).json({ message: 'Сотрудник успешно добавлен', employee_id: userId });
  } catch (err) {
    logger.error('Ошибка при добавлении сотрудника:', err.message);
    res.status(500).json({ error: 'Ошибка при добавлении сотрудника' });
  }
});

app.get('/responsibles', async (req, res) => {
  try {
    const userId = parseInt(req.query.userId, 10);
    let sql = 'SELECT full_name, position FROM responsibles WHERE id = ?';

    let results;
    if (userId) {
      results = await executeQuery(sql, [userId]);
      if (results[0].position === 'Монтажник') {
        return res.status(200).json([results[0].full_name]);
      }
    }

    // Для всех остальных ролей возвращаем список всех ответственных
    sql = 'SELECT full_name FROM responsibles';
    results = await executeQuery(sql);
    const employeeNames = results.map(result => result.full_name);

    res.status(200).json(employeeNames);
  } catch (err) {
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/responsibles/check/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const sql = 'SELECT * FROM responsibles WHERE id = ?';
    const result = await executeQuery(sql, [userId]);
    const isResponsible = result.length > 0;

    res.status(200).json({ isResponsible });
  } catch (err) {
    logger.error('Ошибка при проверке ответственности пользователя: ', err.message);
    res.status(500).json({ error: 'Ошибка сервера при проверке ответственности пользователя' });
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

const logClientChange = async (clientId, userId, description) => {
  try {
    const sql = 'INSERT INTO client_changes (client_id, user_id, change_description) VALUES (?, ?, ?)';
    await executeQuery(sql, [clientId, userId, description]);
  } catch (error) {
    logger.error('Ошибка при логировании изменений клиента:', error.message);
  }
};

const logEmployeeChange = async (employeeId, userId, description) => {
  try {
    const sql = 'INSERT INTO employee_changes (employee_id, user_id, change_description) VALUES (?, ?, ?)';
    await executeQuery(sql, [employeeId, userId, description]);
  } catch (error) {
    logger.error('Ошибка при логировании изменений сотрудника:', error.message);
  }
};

const logInventoryChange = async (itemId, userId, description) => {
  try {
    const sql = 'INSERT INTO inventory_changes (item_id, user_id, change_description) VALUES (?, ?, ?)';
    await executeQuery(sql, [itemId, userId, description]);
  } catch (error) {
    logger.error('Ошибка при логировании изменений инвентаря:', error.message);
  }
};

// Новый маршрут для получения истории изменений всех клиентов
app.get('/clients/changes/all', async (req, res) => {
  try {
    const sql = `
      SELECT cc.id, c.full_name as client_full_name, e.full_name as user_full_name, cc.change_timestamp, cc.change_description 
      FROM client_changes cc
      JOIN clients c ON cc.client_id = c.id
      JOIN employees e ON cc.user_id = e.id
      ORDER BY cc.change_timestamp DESC
    `;
    const changes = await executeQuery(sql);
    res.status(200).json(changes);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка при получении истории изменений' });
  }
});

app.get('/employees/changes/all', async (req, res) => {
  try {
    const sql = 'SELECT * FROM employee_changes ORDER BY change_timestamp DESC';
    const changes = await executeQuery(sql);
    res.status(200).json(changes);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка при получении истории изменений сотрудников' });
  }
});

app.get('/inventory/changes/all', async (req, res) => {
  try {
    const sql = 'SELECT * FROM inventory_changes ORDER BY change_timestamp DESC';
    const changes = await executeQuery(sql);
    res.status(200).json(changes);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка при получении истории изменений инвентаря' });
  }
});

app.get('/clientsbase', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const countSql = 'SELECT COUNT(*) AS total FROM clients';
    const [{ total }] = await executeQuery(countSql);
    const totalPages = Math.ceil(total / limit);

    const sql = 'SELECT * FROM clients LIMIT ? OFFSET ?';
    const results = await executeQuery(sql, [limit, offset]);

    res.status(200).json({ clients: results, totalPages: totalPages });
  } catch (err) {
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/tasks/:taskId/inventory', async (req, res) => {
  const { taskId } = req.params;

  try {
    const sql = `
      SELECT i.name, i.measure, ti.quantity
      FROM task_inventory ti
      JOIN inventory i ON ti.inventory_id = i.id
      WHERE ti.task_id = ?
    `;
    const inventoryData = await executeQuery(sql, [taskId]);
    res.status(200).json(inventoryData);
  } catch (err) {
    logger.error('Ошибка при получении инвентаря для задачи:', err.message);
    res.status(500).json({ error: 'Ошибка при получении инвентаря для задачи' });
  }
});

app.put('/employees/:employeeId', async (req, res) => {
  const { employeeId } = req.params;
  const { full_name, phone_number, email, position, isResponsible, username, password } = req.body;

  if (!full_name || !phone_number) {
    return res.status(400).json({ error: 'ФИО и номер телефона обязательны для обновления.' });
  }

  try {
    // Обновляем данные в таблице employees
    const sqlUpdateEmployee = 'UPDATE employees SET full_name = ?, phone_number = ?, email = ?, position = ? WHERE id = ?';
    await executeQuery(sqlUpdateEmployee, [full_name, phone_number, email, position, employeeId]);

    // Проверка и обновление статуса ответственного
    const responsibleExists = await executeQuery('SELECT * FROM responsibles WHERE id = ?', [employeeId]);
    if (isResponsible === 'Да') {
      if (responsibleExists.length > 0) {
        // Обновляем данные в таблице responsibles
        const sqlUpdateResponsible = 'UPDATE responsibles SET full_name = ?, phone_number = ?, email = ?, position = ? WHERE id = ?';
        await executeQuery(sqlUpdateResponsible, [full_name, phone_number, email, position, employeeId]);
      } else {
        // Добавляем запись в responsibles
        const sqlInsertResponsible = 'INSERT INTO responsibles (id, full_name, phone_number, email, position) VALUES (?, ?, ?, ?, ?)';
        await executeQuery(sqlInsertResponsible, [employeeId, full_name, phone_number, email, position]);
      }
    } else if (responsibleExists.length > 0) {
      // Удаляем запись из responsibles
      const sqlDeleteResponsible = 'DELETE FROM responsibles WHERE id = ?';
      await executeQuery(sqlDeleteResponsible, [employeeId]);
    }

    if (username) {
      let updateUserSql = 'UPDATE users SET username = ?';
      let queryParams = [username];

      // Проверка, является ли пароль хешем
      if (password && !password.startsWith('$2b$')) {
        const hashedPassword = await bcrypt.hash(password, 10);
        updateUserSql += ', password = ?';
        queryParams.push(hashedPassword);
      }

      updateUserSql += ' WHERE id = ?';
      queryParams.push(employeeId);

      await executeQuery(updateUserSql, queryParams);
    }
    await logEmployeeChange(employeeId, 1, 'Обновлены данные сотрудника');
    res.status(200).json({ message: 'Данные сотрудника успешно обновлены' });
  } catch (err) {
    logger.error('Ошибка при обновлении сотрудника:', err.message);
    res.status(500).json({ error: 'Ошибка при обновлении сотрудника' });
  }
});

app.delete('/employees/:employeeId', async (req, res) => {
  const { employeeId } = req.params;

  try {
    // Отключаем проверку внешних ключей
    await executeQuery('SET FOREIGN_KEY_CHECKS=0');

    // Выполняем операцию удаления
    const sqlDelete = 'DELETE FROM employees WHERE id = ?';
    await executeQuery(sqlDelete, [employeeId]);

    // Включаем проверку внешних ключей обратно
    await executeQuery('SET FOREIGN_KEY_CHECKS=1');

    // Логирование удаления сотрудника
    await logEmployeeChange(employeeId, 1, 'Удален сотрудник');

    res.status(200).json({ message: 'Сотрудник успешно удален' });
  } catch (err) {
    logger.error('Ошибка при удалении сотрудника:', err.message);

    // В случае ошибки также стоит убедиться, что проверка внешних ключей включена обратно
    try {
      await executeQuery('SET FOREIGN_KEY_CHECKS=1');
    } catch (error) {
      logger.error('Ошибка при включении FOREIGN_KEY_CHECKS:', error.message);
    }

    res.status(500).json({ error: 'Ошибка при удалении сотрудника' });
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

app.get('/user_tasks', async (req, res) => {
  try {
    let userRole;
    let userId = req.query.userId;

    if (!userId) {
      return res.status(400).json({ error: 'Необходимо предоставить userId' });
    }

    userId = parseInt(userId, 10); // Преобразуем userId в число

    // Получаем роль пользователя из базы данных
    const userRoleResult = await executeQuery('SELECT position FROM employees WHERE id = ?', [userId]);
    userRole = userRoleResult[0].position;

    let sql = 'SELECT * FROM tasks';
    let params = [];

    // Если пользователь - монтажник, выбираем только те задачи, в которых он участвует
    if (userRole === 'Монтажник') {
      sql += ' INNER JOIN task_employees ON tasks.id = task_employees.task_id WHERE task_employees.employee_id = ?';
      params.push(userId);
    }

    const tasks = await executeQuery(sql, params);
    res.status(200).json(tasks);
  } catch (err) {
    logger.error('Ошибка при получении задач:', err.message);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});


// Этот маршрут получает черновик задачи по её ID
app.get('/tasks/draft/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const sql = 'SELECT * FROM tasks WHERE id = ?';
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
    const userId = parseInt(req.query.userId, 10);

    let userRole;
    // Получаем роль пользователя
    if (userId) {
      const userRoleResult = await executeQuery('SELECT position FROM employees WHERE id = ?', [userId]);
      userRole = userRoleResult[0]?.position;
    }

    let sql;
    let params = [];

    if (userRole === 'Монтажник') {
      // Фильтруем задачи по тем, в которых участвует пользователь
      sql = `
        SELECT 
          DATE(tasks.start_date) AS task_date, 
          tasks.status 
        FROM tasks
        INNER JOIN task_employees ON tasks.id = task_employees.task_id 
        WHERE task_employees.employee_id = ? AND tasks.status IN ('новая', 'в процессе')`;
      params.push(userId);
    } else {
      // Запрос для всех пользователей
      sql = `
        SELECT 
          DATE(start_date) AS task_date, 
          status 
        FROM tasks
        WHERE status IN ('новая', 'в процессе')`;
    }

    const results = await executeQuery(sql, params);

    const taskDates = results.reduce((acc, result) => {
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

app.get('/inventoryBase', async (req, res) => {
  try {
    // Получаем номер страницы и размер страницы из параметров запроса, с значениями по умолчанию
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    // Сначала получаем общее количество записей в таблице inventory для расчета общего количества страниц
    const countSql = 'SELECT COUNT(*) AS total FROM inventory';
    const [{ total }] = await executeQuery(countSql);
    const totalPages = Math.ceil(total / limit);

    // Затем получаем записи с учетом пагинации
    const sql = 'SELECT * FROM inventory LIMIT ? OFFSET ?';
    const results = await executeQuery(sql, [limit, offset]);

    // Отправляем результаты вместе с информацией о пагинации
    res.status(200).json({ inventory: results, totalPages: totalPages });
  } catch (err) {
    logger.error('Ошибка при получении инвентаря:', err.message);
    res.status(500).json({ error: 'Ошибка при получении инвентаря' });
  }
});

app.post('/inventory', async (req, res) => {
  const { name, measure, quantity } = req.body;

  if (!name || !measure) {
    return res.status(400).json({ error: 'Название и единица измерения являются обязательными полями.' });
  }

  try {
    const sql = 'INSERT INTO inventory (name, measure, quantity) VALUES (?, ?, ?)';
    const result = await executeQuery(sql, [name, measure, quantity]);
    res.status(201).json({ message: 'Элемент инвентаря успешно добавлен', inventory_id: result.insertId });
  } catch (err) {
    logger.error('Ошибка при добавлении элемента инвентаря:', err.message);
    res.status(500).json({ error: 'Ошибка при добавлении элемента инвентаря' });
  }
});

app.put('/inventory/:inventoryId', async (req, res) => {
  const { inventoryId } = req.params;
  const { name, measure, quantity } = req.body;

  try {
    const sql = 'UPDATE inventory SET name = ?, measure = ?, quantity = ? WHERE id = ?';
    await executeQuery(sql, [name, measure, quantity, inventoryId]);
    res.status(200).json({ message: 'Данные элемента инвентаря успешно обновлены' });
  } catch (err) {
    logger.error('Ошибка при обновлении элемента инвентаря:', err.message);
    res.status(500).json({ error: 'Ошибка при обновлении элемента инвентаря' });
  }
});

app.delete('/inventory/:inventoryId', async (req, res) => {
  const { inventoryId } = req.params;

  try {
    // Отключаем проверку внешних ключей
    await executeQuery('SET FOREIGN_KEY_CHECKS=0');

    // Выполняем операцию удаления
    const sqlDelete = 'DELETE FROM inventory WHERE id = ?';
    await executeQuery(sqlDelete, [inventoryId]);

    // Включаем проверку внешних ключей обратно
    await executeQuery('SET FOREIGN_KEY_CHECKS=1');

    await logInventoryChange(inventoryId, 1, 'Удален предмет');

    res.status(200).json({ message: 'Элемент инвентаря успешно удален' });
  } catch (err) {
    logger.error('Ошибка при удалении элемента инвентаря:', err.message);

    // В случае ошибки также стоит убедиться, что проверка внешних ключей включена обратно
    try {
      await executeQuery('SET FOREIGN_KEY_CHECKS=1');
    } catch (error) {
      logger.error('Ошибка при включении FOREIGN_KEY_CHECKS:', error.message);
    }

    res.status(500).json({ error: 'Ошибка при удалении элемента инвентаря' });
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

app.post('/services', (req, res) => {
  let { service_name, cost } = req.body;
  if (!service_name || !cost) {
    return res.status(400).send('Название и стоимость услуги обязательны для заполнения.');
  }
  cost = parseFloat(cost); // Убедимся, что стоимость преобразована в число
  const service = { service_name, cost };

  const query = 'INSERT INTO services SET ?';
  db.query(query, service, (err, result) => {
    if (err) {
      console.error('Ошибка при добавлении услуги: ', err);
      res.status(500).send('Ошибка сервера при добавлении услуги');
    } else {
      res.status(201).send(`Услуга добавлена с ID: ${result.insertId}`);
    }
  });
});

app.delete('/services/:serviceId', async (req, res) => {
  const { serviceId } = req.params; // Получаем идентификатор услуги из параметров запроса

  try {
    // Отключаем проверку внешних ключей
    await executeQuery('SET FOREIGN_KEY_CHECKS=0');

    // SQL запрос для удаления услуги из базы данных
    const sql = 'DELETE FROM services WHERE id = ?';

    // Выполнение запроса к базе данных
    const result = await executeQuery(sql, [serviceId]);

    // Включаем проверку внешних ключей обратно
    await executeQuery('SET FOREIGN_KEY_CHECKS=1');

    // Проверка, была ли действительно удалена запись
    if (result.affectedRows === 0) {
      // Если запись не найдена, отправляем статус 404
      return res.status(404).json({ message: 'Услуга не найдена или уже была удалена.' });
    }

    // Отправка ответа клиенту о успешном удалении
    res.status(200).json({ message: 'Услуга успешно удалена.' });
  } catch (err) {
    // В случае ошибки также стоит убедиться, что проверка внешних ключей включена обратно
    try {
      await executeQuery('SET FOREIGN_KEY_CHECKS=1');
    } catch (error) {
      console.error('Ошибка при включении FOREIGN_KEY_CHECKS:', error);
    }

    // Логирование ошибки и отправка ответа с кодом 500 в случае возникновения исключения
    console.error('Ошибка при удалении услуги:', err);
    res.status(500).json({ error: 'Произошла ошибка при удалении услуги.' });
  }
});

app.put('/services/:serviceId', async (req, res) => {
  const { serviceId } = req.params;
  const { service_name, cost } = req.body;

  // Проверка наличия всех необходимых данных
  if (!service_name || cost === undefined) {
    return res.status(400).json({ error: 'Необходимо указать название услуги и её стоимость.' });
  }

  try {
    // Обновление данных услуги
    const sql = 'UPDATE services SET service_name = ?, cost = ? WHERE id = ?';
    await executeQuery(sql, [service_name, cost, serviceId]);

    res.status(200).json({ message: 'Данные услуги успешно обновлены.' });
  } catch (error) {
    console.error('Ошибка при обновлении услуги:', error);
    res.status(500).json({ error: 'Произошла ошибка при обновлении данных услуги.' });
  }
});

app.post('/tasks', async (req, res) => {
  try {
    const {
      status, service, payment, cost, start_date, end_date, start_time,
      end_time, responsible, fullname_client, address_client, phone,
      description, employees
    } = req.body;

    const checkRequiredFields = ({ service, payment, cost, start_date, start_time, responsible, employees, fullname_client, address_client, phone }) => {
      let missingFields = [];

      if (!service) missingFields.push('Услуга');
      if (!payment) missingFields.push('Способ оплаты');
      if (!cost) missingFields.push('Стоимость');
      if (!start_date) missingFields.push('Дата начала');
      if (!start_time) missingFields.push('Время начала');
      if (!responsible) missingFields.push('Ответственный');
      if (!employees) missingFields.push('Сотрудники');
      if (!fullname_client) missingFields.push('ФИО клиента');
      if (!address_client) missingFields.push('Адрес клиента');
      if (!phone) missingFields.push('Телефон');

      return missingFields;
    };

    // Использование функции в вашем условии
    if (status !== 'черновик') {
      const missingFields = checkRequiredFields({ service, payment, cost, start_date, start_time, responsible, employees, fullname_client, address_client, phone });
      if (missingFields.length > 0) {
        const missingFieldsString = missingFields.join(', ');
        logger.error(`Ошибка: Не заполнены обязательные поля: ${missingFieldsString}`);
        return res.status(400).json({ error: `Не заполнены обязательные поля: ${missingFieldsString}` });
      }
    }

    const taskSql = `INSERT INTO tasks (status, service, payment, cost, start_date, end_date, start_time, end_time, responsible, fullname_client, address_client, phone, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const taskResult = await executeQuery(taskSql, [status, service, payment, cost, start_date, end_date, start_time, end_time, responsible, fullname_client, address_client, phone, description]);
    const taskId = taskResult.insertId;

    if (employees && employees.length) {
      const employeeExistenceResults = await executeQuery('SELECT id FROM employees WHERE id IN (?)', [employees]);
      if (employeeExistenceResults.length !== employees.length) {
        return res.status(400).json({ error: 'Один или несколько предоставленных ID сотрудников не существуют' });
      }

      const employeeTasksValues = employees.map(id => [taskId, id]);
      await executeQuery('INSERT INTO task_employees (task_id, employee_id) VALUES ?', [employeeTasksValues]);

      const updateCountResults = await executeQuery('SELECT task_id, COUNT(employee_id) as employee_count FROM task_employees GROUP BY task_id');
      for (const row of updateCountResults) {
        if (row.task_id === taskId) {
          await executeQuery('UPDATE tasks SET employees = ? WHERE id = ?', [row.employee_count, taskId]);
        }
      }

      res.status(201).json({ message: 'Задача и связи с участниками успешно созданы', task_id: taskId });
    } else {
      logger.info('Задача добавлена без сотрудников');
      res.status(201).json({ message: 'Задача успешно добавлена без участников', task_id: taskId });
    }
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
        connection.commit(async (commitErr) => {
          if (commitErr) {
            throw commitErr; // Сгенерирует ошибку и перейдет к блоку catch
          }
          connection.release(); // Освободить соединение после коммита
          for (const item of inventory) {
            await logInventoryChange(item.inventory_id, 1, `Добавлен инвентарь к задаче ${taskId}`);
          }
          res.status(201).json({ message: 'Инвентарь успешно добавлен и обновлен.' });
        });
      } catch (error) {
        connection.rollback(() => {
          connection.release();
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

app.get('/task_employees/:employeeId', async (req, res) => {
  const { employeeId } = req.params;
  try {
    // SQL-запрос для получения всех задач, связанных с указанным сотрудником
    const sql = 'SELECT task_id FROM task_employees WHERE employee_id = ?';
    const results = await executeQuery(sql, [employeeId]);

    // Преобразовываем результаты в список идентификаторов задач
    const taskIds = results.map(row => row.task_id);
    res.status(200).json(taskIds);
  } catch (err) {
    logger.error('Ошибка при получении задач сотрудника:', err.message);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/api/task-info', async (req, res) => {
  try {
    // Запрос для получения информации из task_employees и соответствующих дат и времени из tasks
    const sql = `
      SELECT te.task_id, te.employee_id, t.start_date, t.end_date, t.start_time, t.end_time
      FROM task_employees te
      INNER JOIN tasks t ON te.task_id = t.id
    `;
    const results = await executeQuery(sql);

    if (results.length === 0) {
      return res.status(404).json({ error: 'Информация не найдена.' });
    }

    res.status(200).json(results);
  } catch (error) {
    logger.error('Ошибка при получении информации о задачах и сотрудниках:', error.message);
    res.status(500).json({ error: 'Ошибка сервера при получении информации о задачах и сотрудниках' });
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

        // Обработка списка сотрудников
        if (employees) {
          const employeeIds = employees.map(employee => employee.id);
          const deleteOldLinksSql = 'DELETE FROM task_employees WHERE task_id = ?';
          await executeQuery(deleteOldLinksSql, [taskId]);

          const insertNewLinksSql = 'INSERT INTO task_employees (task_id, employee_id) VALUES ?';
          const newLinksValues = employeeIds.map(employeeId => [taskId, employeeId]);
          await executeQuery(insertNewLinksSql, [newLinksValues]);
        }

        // Обработка списка услуг
        if (services && services.length) {
          const deleteExistingServicesSql = 'DELETE FROM task_services WHERE task_id = ?';
          await executeQuery(deleteExistingServicesSql, [taskId]);

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
        // Вычитаем количество инвентаря
        for (const item of inventoryItems) {
          const updateInventorySql = 'UPDATE inventory SET quantity = GREATEST(0, quantity - ?) WHERE id = ?';
          await new Promise((resolve, reject) => {
            connection.query(updateInventorySql, [item.quantity, item.inventory_id], (queryErr, results) => {
              if (queryErr) reject(queryErr);
              else resolve(results);
            });
          });

          // Добавляем запись в task_inventory
          const insertTaskInventorySql = 'INSERT INTO task_inventory (task_id, inventory_id, quantity) VALUES (?, ?, ?)';
          await new Promise((resolve, reject) => {
            connection.query(insertTaskInventorySql, [taskId, item.inventory_id, item.quantity], (queryErr, results) => {
              if (queryErr) reject(queryErr);
              else resolve(results);
            });
          });
        }
        connection.commit(async (commitErr) => {
          if (commitErr) {
            throw commitErr; // Сгенерирует ошибку и перейдет к блоку catch
          }
          connection.release(); // Освобождаем соединение после коммита
          try {
            for (const item of inventoryItems) {
              // Логируем изменение инвентаря после списания
              await logInventoryChange(item.inventory_id, 1, `Списан инвентарь по задаче ${taskId}`);
            }
            res.status(200).json({ message: 'Задача выполнена и инвентарь обновлён' });
          } catch (logError) {
            logger.error('Ошибка при логировании изменений инвентаря:', logError.message);
            // Возвращаем ошибку клиенту
            res.status(500).json({ error: 'Ошибка при логировании изменений инвентаря' });
          }
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

app.delete('/tasks/:taskId', async (req, res) => {
  const { taskId } = req.params;

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
        const photos = await executeQuery('SELECT photo_url FROM task_photos WHERE task_id = ?', [taskId], connection);

        // Удаляем файлы фотографий из файловой системы
        photos.forEach(photo => {
          const filePath = path.join(__dirname, photo.photo_url);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        });

        // Удаляем записи о фотографиях из базы данных
        await executeQuery('DELETE FROM task_photos WHERE task_id = ?', [taskId], connection);

        // Удаляем связанные данные из task_employees
        await executeQuery('DELETE FROM task_employees WHERE task_id = ?', [taskId], connection);

        // Восстановление инвентаря перед удалением записей в task_inventory
        const inventoryToUpdate = await executeQuery('SELECT inventory_id, quantity FROM task_inventory WHERE task_id = ?', [taskId], connection);
        for (const item of inventoryToUpdate) {
          await executeQuery('UPDATE inventory SET quantity = quantity + ? WHERE id = ?', [item.quantity, item.inventory_id], connection);
        }

        // Удаляем связанные данные из task_inventory
        await executeQuery('DELETE FROM task_inventory WHERE task_id = ?', [taskId], connection);
        for (const item of inventoryToUpdate) {
          await logInventoryChange(item.inventory_id, 1, `Инвентарь возвращен на склад после удаления задачи`);
        }

        // Удаляем связанные данные из task_services
        await executeQuery('DELETE FROM task_services WHERE task_id = ?', [taskId], connection);

        // Удаляем саму задачу
        await executeQuery('DELETE FROM tasks WHERE id = ?', [taskId], connection);

        // Подтверждение транзакции
        connection.commit((commitErr) => {
          if (commitErr) throw commitErr;
          connection.release();
          res.status(200).json({ message: 'Задача и все связанные данные успешно удалены.' });
        });
      } catch (error) {
        // Откат транзакции в случае ошибки
        connection.rollback(() => {
          connection.release();
          logger.error('Ошибка при удалении задачи:', error.message);
          res.status(500).json({ error: 'Ошибка при удалении задачи.' });
        });
      }
    });
  });
});


app.put('/clients/:clientId', async (req, res) => {
  const { clientId } = req.params;
  const { full_name, phone_number, address } = req.body;

  if (!full_name || !phone_number) {
    return res.status(400).json({ error: 'ФИО и номер телефона обязательны для обновления.' });
  }

  try {
    const sql = 'UPDATE clients SET full_name = ?, phone_number = ?, address = ? WHERE id = ?';
    await executeQuery(sql, [full_name, phone_number, address, clientId]);

    // Логирование обновления клиента
    await logClientChange(clientId, 1, 'Обновлены данные клиента');

    res.status(200).json({ message: 'Данные клиента успешно обновлены' });
  } catch (err) {
    logger.error('Ошибка при обновлении клиента:', err.message);
    res.status(500).json({ error: 'Ошибка при обновлении клиента' });
  }
});

app.delete('/clients/:clientId', async (req, res) => {
  const { clientId } = req.params;

  try {
    // Отключаем проверку внешних ключей
    await executeQuery('SET FOREIGN_KEY_CHECKS=0');

    // Выполняем операцию удаления
    const sqlDelete = 'DELETE FROM clients WHERE id = ?';
    await executeQuery(sqlDelete, [clientId]);

    // Включаем проверку внешних ключей обратно
    await executeQuery('SET FOREIGN_KEY_CHECKS=1');

    // Логирование удаления клиента
    await logClientChange(clientId, 1, 'Удален клиент');

    res.status(200).json({ message: 'Клиент успешно удален' });
  } catch (err) {
    logger.error('Ошибка при удалении клиента:', err.message);

    // В случае ошибки также стоит убедиться, что проверка внешних ключей включена обратно
    try {
      await executeQuery('SET FOREIGN_KEY_CHECKS=1');
    } catch (error) {
      logger.error('Ошибка при включении FOREIGN_KEY_CHECKS:', error.message);
    }

    res.status(500).json({ error: 'Ошибка при удалении клиента' });
  }
});

app.post('/clients', async (req, res) => {
  const { full_name, phone_number, address } = req.body;

  if (!full_name || !phone_number) {
    return res.status(400).json({ error: 'ФИО и номер телефона являются обязательными полями.' });
  }

  try {
    const sql = 'INSERT INTO clients (full_name, phone_number, address) VALUES (?, ?, ?)';
    const result = await executeQuery(sql, [full_name, phone_number, address]);

    // Логирование добавления клиента
    await logClientChange(result.insertId, 1, 'Добавлен новый клиент');

    res.status(201).json({ message: 'Клиент успешно добавлен', client_id: result.insertId });
  } catch (err) {
    logger.error('Ошибка при добавлении клиента в базу данных:', err.message);
    res.status(500).json({ error: 'Ошибка при добавлении клиента' });
  }
});

app.post('/tasks/:taskId/employees', async (req, res) => {
  const { taskId } = req.params;
  const { employees } = req.body;

  if (!employees || !employees.length) {
    return res.status(400).json({ error: 'Необходимо предоставить массив ID сотрудников.' });
  }

  const insertValues = employees.map(employeeId => [parseInt(taskId, 10), parseInt(employeeId, 10)]);
  const sql = 'INSERT INTO task_employees (task_id, employee_id) VALUES ?';

  try {
    await new Promise((resolve, reject) => {
      db.query(sql, [insertValues], (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    for (const employeeId of employees) {
      await logEmployeeChange(parseInt(employeeId, 10), 1, `Добавлен сотрудник к задаче ${taskId}`);
    }

    res.status(201).json({ message: 'Сотрудники успешно добавлены к задаче' });
  } catch (err) {
    logger.error('Ошибка при добавлении сотрудников к задаче:', err.message);
    res.status(500).json({ error: 'Ошибка при добавлении сотрудников к задаче' });
  }
});


app.get('/', (req, res) => {
  res.send('Добро пожаловать на сервер!');
});

app.use(errorHandler);

https.createServer(sslOptions, app).listen(port, () => {
  logger.info(`Сервер запущен на порту ${port}`);
});

app.on('error', (err) => {
  logger.error('Ошибка запуска сервера: ' + err.message);
  process.exit(1);
});