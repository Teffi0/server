const Validator = require('validator');
const isEmpty = require('is-empty');

function validateRegistrationInput(data) {
  let errors = {};

  // Преобразование пустых полей в пустую строку для использования функции validator
  data.username = !isEmpty(data.username) ? data.username : "";
  data.password = !isEmpty(data.password) ? data.password : "";

  // Проверка имени пользователя
  if (Validator.isEmpty(data.username)) {
    errors.username = "Необходимо указать имя пользователя";
  }

  // Проверка пароля
  if (Validator.isEmpty(data.password)) {
    errors.password = "Необходимо указать пароль";
  } else if (!Validator.isLength(data.password, { min: 6, max: 30 })) {
    errors.password = "Пароль должен содержать от 6 до 30 символов";
  }

  return {
    errors,
    isValid: isEmpty(errors)
  };
}

function validateLoginInput(data) {
  let errors = {};

  // Преобразование пустых полей в пустую строку
  data.username = !isEmpty(data.username) ? data.username : "";
  data.password = !isEmpty(data.password) ? data.password : "";

  // Проверка имени пользователя
  if (Validator.isEmpty(data.username)) {
    errors.username = "Необходимо указать имя пользователя";
  }

  // Проверка пароля
  if (Validator.isEmpty(data.password)) {
    errors.password = "Необходимо указать пароль";
  }

  return {
    errors,
    isValid: isEmpty(errors)
  };
}

module.exports = {
  validateRegistrationInput,
  validateLoginInput
};
