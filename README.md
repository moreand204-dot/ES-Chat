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
