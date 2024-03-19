import { initializeApp } from "firebase/app";

import { getDatabase, ref, set, get, child } from 'firebase/database';

const firebaseConfig = {
    apiKey: "AIzaSyABhgL0V4ZIqvXfoxfn1UW92lYLiZG3Dtw",
    authDomain: "isktest-71def.firebaseapp.com",
    projectId: "isktest-71def",
    storageBucket: "isktest-71def.appspot.com",
    messagingSenderId: "814174503865",
    appId: "1:814174503865:web:9ac761df02b9d25ac46c68"
};

export const _ = initializeApp(firebaseConfig);
const db = getDatabase();
const dbRef = ref(db);

export const saveToken = async (userId: string, token: string) => {
    try {
        // Получение текущих значений токенов для пользователя
        const userTokensRef = ref(db, `userTokens/${userId}/`);
        const snapshot = await get(child(userTokensRef, `/`));
        const values = snapshot.val() ?? {};

        // Создание нового payload с обновленным токеном
        const payload = { ...values, token };

        // Сохранение обновленного payload в базу данных
        await set(userTokensRef, payload);
    } catch (error) {
        console.error("Ошибка при сохранении токена:", error);
    }
}