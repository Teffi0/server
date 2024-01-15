const express = require('express');
const multer = require('multer');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { validateLoginInput, validateRegistrationInput } = require('./validation');
const admin = require('firebase-admin');
const db = require('./config/database');
const morgan = require('morgan');
const logger = require('./logger');
const fs = require('fs');
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
      console.log(newInventory);
      try {
        // Получаем текущие данные инвентаря для задачи
        const oldInventoryData = await executeQuery('SELECT inventory_id, quantity FROM task_inventory WHERE task_id = ?', [taskId], connection);

        // Восстанавливаем количество инвентаря на складе на основе старых данных
        for (const oldItem of oldInventoryData) {
          await executeQuery('UPDATE inventory SET quantity = quantity + ? WHERE id = ?', [oldItem.quantity, oldItem.inventory_id], connection);
        }

        // Удаление старых данных
        await executeQuery('DELETE FROM task_inventory WHERE task_id = ?', [taskId], connection);

        // Обновление данных инвентаря и уменьшение количества на складе
        for (const newItem of newInventory) {
          await executeQuery('UPDATE inventory SET quantity = quantity - ? WHERE id = ?', [newItem.quantity, newItem.inventory_id], connection);
          await executeQuery('INSERT INTO task_inventory (task_id, inventory_id, quantity) VALUES (?, ?, ?)', [taskId, newItem.inventory_id, newItem.quantity], connection);
        }

        connection.commit((commitErr) => {
          if (commitErr) {
            throw commitErr; // Вызовет ошибку, которая будет перехвачена ниже
          }
          connection.release();
          res.status(200).json({ message: 'Инвентарь успешно обновлен.' });
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
  const { errors, isValid } = validateLoginInput(req.body);

  // Проверка валидности входных данных
  if (!isValid) {
    return res.status(400).json(errors);
  }

  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Необходимо указать имя пользователя и пароль.' });
  }

  try {
    const sql = 'SELECT * FROM users WHERE username = ?';
    const users = await executeQuery(sql, [username]);
    console.log(users);

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

    console.log(employeeData);

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

app.post('/employees', async (req, res) => {
  const { full_name, phone_number, email, position } = req.body;

  if (!full_name || !phone_number) {
    return res.status(400).json({ error: 'ФИО и номер телефона являются обязательными полями.' });
  }

  try {
    const sql = 'INSERT INTO employees (full_name, phone_number, email, position) VALUES (?, ?, ?, ?)';
    const result = await executeQuery(sql, [full_name, phone_number, email, position]);
    await logEmployeeChange(result.insertId, 1, 'Добавлен новый сотрудник');
    res.status(201).json({ message: 'Сотрудник успешно добавлен', employee_id: result.insertId });
  } catch (err) {
    logger.error('Ошибка при добавлении сотрудника:', err.message);
    res.status(500).json({ error: 'Ошибка при добавлении сотрудника' });
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
    console.log(clientId, userId, description);
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
    const sql = 'SELECT * FROM client_changes ORDER BY change_timestamp DESC';
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
  const { full_name, phone_number, email, position } = req.body;

  if (!full_name || !phone_number) {
    return res.status(400).json({ error: 'ФИО и номер телефона обязательны для обновления.' });
  }

  try {
    const sql = 'UPDATE employees SET full_name = ?, phone_number = ?, email = ?, position = ? WHERE id = ?';
    await executeQuery(sql, [full_name, phone_number, email, position, employeeId]);
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
    const sql = 'DELETE FROM employees WHERE id = ?';
    await executeQuery(sql, [employeeId]);
    await logEmployeeChange(employeeId, 1, 'Удален сотрудник');
    res.status(200).json({ message: 'Сотрудник успешно удален' });
  } catch (err) {
    logger.error('Ошибка при удалении сотрудника:', err.message);
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
    let userId;
    
    const token = req.headers.authorization.split(' ')[1];
    console.log(token);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    userId = decoded.id;
    console.log(userId);

    // Получаем роль пользователя из базы данных
    const userRoleResult = await executeQuery('SELECT position FROM employees WHERE id = ?', [userId]);
    userRole = userRoleResult[0].role;

    console.log(userRole);
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
    const sql = 'DELETE FROM inventory WHERE id = ?';
    await executeQuery(sql, [inventoryId]);
    res.status(200).json({ message: 'Элемент инвентаря успешно удален' });
  } catch (err) {
    logger.error('Ошибка при удалении элемента инвентаря:', err.message);
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


app.post('/tasks', async (req, res) => {
  try {
    const {
      status, service, payment, cost, start_date, end_date, start_time,
      end_time, responsible, fullname_client, address_client, phone,
      description, employees
    } = req.body;

    if (status !== 'черновик' && (!service || !payment || !cost || !start_date || !end_date || !start_time || !end_time || !responsible || !fullname_client || !address_client || !phone || !description)) {
      logger.error('Ошибка: Не все поля задачи заполнены');
      return res.status(400).json({ error: 'Не все поля задачи заполнены' });
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

app.get('/task_employees/:employeeId', async (req, res) => {
  const { employeeId } = req.params;
  try {
    // SQL-запрос для получения всех задач, связанных с указанным сотрудником
    const sql = 'SELECT task_id FROM task_employees WHERE employee_id = ?';
    const results = await executeQuery(sql, [employeeId]);

    // Преобразовываем результаты в список идентификаторов задач
    const taskIds = results.map(row => row.task_id);
    console.log(taskIds);
    res.status(200).json(taskIds);
  } catch (err) {
    logger.error('Ошибка при получении задач сотрудника:', err.message);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
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
        // Удаляем связанные данные из task_employees
        await executeQuery('DELETE FROM task_employees WHERE task_id = ?', [taskId], connection);

        // Восстановление инвентаря перед удалением записей в task_inventory
        const inventoryToUpdate = await executeQuery('SELECT inventory_id, quantity FROM task_inventory WHERE task_id = ?', [taskId], connection);
        for (const item of inventoryToUpdate) {
          await executeQuery('UPDATE inventory SET quantity = quantity + ? WHERE id = ?', [item.quantity, item.inventory_id], connection);
        }

        // Удаляем связанные данные из task_inventory
        await executeQuery('DELETE FROM task_inventory WHERE task_id = ?', [taskId], connection);

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
    const sql = 'DELETE FROM clients WHERE id = ?';
    console.log(sql);
    await executeQuery(sql, [clientId]);

    // Логирование удаления клиента
    await logClientChange(clientId, 1, 'Удален клиент');

    res.status(200).json({ message: 'Клиент успешно удален' });
  } catch (err) {
    logger.error('Ошибка при удалении клиента:', err.message);
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