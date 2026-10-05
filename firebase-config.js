// إعدادات Firebase بتاعة مشروع escanor-chat-8178c
export const firebaseConfig = {
  apiKey: "AIzaSyCts7srrieOCyWb0MBIHfJbZ6Sh5FrUrxQ",
  authDomain: "escanor-chat-8178c.firebaseapp.com",
  databaseURL: "https://escanor-chat-8178c-default-rtdb.firebaseio.com",
  projectId: "escanor-chat-8178c",
  storageBucket: "escanor-chat-8178c.firebasestorage.app",
  messagingSenderId: "657166584629",
  appId: "1:657166584629:web:070063bf65194bcaa0da7c",
  measurementId: "G-WWXT1CY5HM"
};

// إيميل المالك (لازم يكون نفس الإيميل المكتوب في firestore.rules)
export const OWNER_EMAIL = "moreand458@gmail.com";

// مفتاح الإشعارات (VAPID): Firebase Console ← Project settings ← Cloud Messaging ← Web Push certificates ← Generate key pair
// سيبه فاضي لو مش عايز إشعارات والموقع مقفول (الإشعارات وهو مفتوح بتشتغل من غيره).
export const VAPID_KEY = "";
