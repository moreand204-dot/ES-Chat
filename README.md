# ES Chat Pro — خطوات التشغيل

## 1) مشروع Firebase
1. ادخل https://console.firebase.google.com ← Add project.
2. Project settings ← Your apps ← أيقونة الويب `</>` ← سجّل التطبيق.
3. انسخ قيم `firebaseConfig` والصقها في ملف `firebase-config.js`.

## 2) تسجيل الدخول بجوجل
Build ← Authentication ← Get started ← Sign-in method ← Google ← Enable ← Save.
بعد ما ترفع الموقع: Authentication ← Settings ← Authorized domains ← أضف دومين موقعك.

## 3) قاعدة البيانات
Build ← Firestore Database ← Create database (Production mode).
بعدين تبويب Rules ← امسح اللي موجود والصق محتوى `firestore.rules` ← Publish.

## 4) رفع الموقع (لازم رابط https)
أسهل خيار: Firebase Hosting (Build ← Hosting)، أو Netlify / Cloudflare Pages / GitHub Pages.
الموقع مش هيشتغل من فتح الملف مباشرة ولا من داخل Acode، لازم يتفتح من رابط.

## 5) المالك
ادخل بإيميل moreand458@gmail.com أول مرة: الحساب بيتوثّق تلقائيًا وتظهرلك أيقونة التاج (لوحة المالك) فوق.
الإيميل متثبّت كمان داخل `firestore.rules` (الحماية الحقيقية هناك).

---
# تحديث 3: الإشعارات (اختياري، للإشعار والموقع مقفول)

الإشعارات والموقع مفتوح (حتى في الخلفية) بتشتغل من غير أي إعداد. عشان توصل والموقع **مقفول تمامًا**:
1. Firebase ← Project settings ← Cloud Messaging ← Web Push certificates ← Generate key pair، وانسخ المفتاح.
2. الصقه في `firebase-config.js` في `VAPID_KEY`.
3. Firebase ← Project settings ← Service accounts ← Generate new private key (بينزل ملف JSON).
4. Vercel ← Project ← Settings ← Environment Variables: الاسم `FIREBASE_SERVICE_ACCOUNT` والقيمة محتوى الملف كله. بعدين Redeploy.
   (ماترفعش ملف المفتاح ده على GitHub ولا تشاركه مع حد).
5. ارفع كل الملفات الجديدة: `api/notify.js` و`package.json` و`firebase-messaging-sw.js`.
6. حدّث قواعد Firestore (firestore.rules).
