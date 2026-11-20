# Telegram-бот «Книга в EPUB»

Присылаете боту ссылку на оглавление книги с kanunu8.com или файл `.epub` и выбираете кнопку:
- **📖 Оригинал** — EPUB на китайском;
- **🇷🇺 Перевод** — EPUB на русском (DeepSeek через OpenRouter);
- **🔀 Китайский + русский** — оригинал над каждым абзацем перевода.

Готовый файл приходит в чат. Пока книга собирается, бот показывает прогресс.

В том же сообщении можно добавить:
```
https://www.kanunu8.com/files/old/2011/2560.html
3
王冕 = Ван Мянь
```
Здесь `3` означает «только первые 3 главы» (удобно для пробы), а строки с `=` задают глоссарий имён.

## Как это устроено
```
Telegram → Cloudflare Worker (bot/worker.js) → GitHub Actions (bot/job.py) → EPUB в Telegram
```
Воркер только принимает сообщения и запускает задачу. Книгу скачивает и переводит GitHub Actions: там нет ограничений по времени, как у Cloudflare. Всё бесплатно, оплачивается только перевод в OpenRouter.

## Настройка (один раз, около 15 минут, можно с iPad)

### 1. Создайте бота
В Telegram откройте **@BotFather**, отправьте `/newbot`, придумайте имя. Сохраните **токен** (вида `123456:AA…`).

### 2. Секреты в GitHub
Репозиторий → **Settings → Secrets and variables → Actions → New repository secret**:
- `TELEGRAM_BOT_TOKEN` — токен бота;
- `OPENROUTER_API_KEY` — ключ OpenRouter (`sk-or-v1-…`).

Модель можно сменить: на вкладке **Variables** создайте `OPENROUTER_MODEL`, например `deepseek/deepseek-r1`. По умолчанию используется `deepseek/deepseek-chat`.

### 3. Токен GitHub для воркера
GitHub → аватар → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**:
- Repository access: **Only select repositories → Blib-**;
- Permissions → Repository permissions → **Contents: Read and write**;
- скопируйте токен (`github_pat_…`).

### 4. Воркер в Cloudflare
1. **Workers & Pages → Create → Start with Hello World!**, имя `book-bot`, нажмите **Deploy**.
2. **Edit code**: удалите всё, вставьте содержимое [`bot/worker.js`](worker.js), нажмите **Deploy**.
3. **Settings → Variables and Secrets → Add**:

| Имя | Тип | Значение |
|---|---|---|
| `BOT_TOKEN` | Secret | токен бота |
| `WEBHOOK_SECRET` | Secret | любая длинная строка из латинских букв и цифр |
| `GH_TOKEN` | Secret | токен GitHub из шага 3 |
| `GH_REPO` | Text | `YinYuanJiaBan/Blib-` |
| `ALLOWED_USERS` | Text | пока `0`, заполните на шаге 6 |

### 5. Подключите бота
Откройте в Safari: `https://book-bot.<ваше-имя>.workers.dev/setup?key=<ваш WEBHOOK_SECRET>`.
Должно быть «Webhook: ✅ установлен» и галочки у всех переменных.

### 6. Разрешите себе доступ
Напишите боту `/id`, и он пришлёт ваш Telegram ID. Впишите его в `ALLOWED_USERS` (несколько ID пишутся через запятую) и нажмите **Deploy**. Посторонние пользователи бота не смогут им пользоваться и тратить ваши деньги.

Готово: отправьте боту ссылку.

## Если что-то не так
- **Бот молчит.** Откройте `/setup?key=…` ещё раз и проверьте галочки.
- **«GitHub не принял задачу».** Проверьте `GH_TOKEN` (права Contents: Read and write на репозиторий Blib-) и `GH_REPO`.
- **Задача запустилась, но упала.** Откройте в репозитории вкладку **Actions** и посмотрите журнал последнего запуска «Книга для Telegram-бота».
- **Перевод прервался.** Нажмите кнопку ещё раз: скачанные главы и переводы сохраняются в кэше Actions, и повторно платить не придётся.

Репозиторий публичный, поэтому список запусков в Actions виден всем. Ссылки на книги, глоссарий и сами тексты в журнал не выводятся.
