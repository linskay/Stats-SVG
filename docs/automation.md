# Автоматизация поставки

## Локальная среда и проверки

Проект использует Node.js 24: это зафиксировано в `.nvmrc` и поле `engines`.
После установки зависимостей единая проверка выполняется командой:

```bash
npm run check
```

Она запускает ESLint, проверку форматирования Prettier и тесты Node.js. Перед
созданием PR используйте Conventional Commit в заголовке: например,
`feat: add profile theme` или `fix: handle empty Steam profile`. Поддерживаемые
типы перечислены в workflow `Conventional Commit`.

## GitHub: настройка один раз

Настройки репозитория и Vercel нельзя безопасно хранить в исходном коде, поэтому
владелец репозитория должен выполнить следующие действия в интерфейсе GitHub.

**Текущий статус проверки (27.10.2026):** GitHub API вернул `protected: false` для
`main`, а список repository rulesets пуст. Следовательно, защита `main` и
обязательность CI сейчас не подтверждены и должны быть включены владельцем до
слияния PR. Это не настраивается изменением файлов репозитория.

1. В **Settings → Branches → Add branch protection rule** создайте правило для
   `main`.
2. Включите **Require a pull request before merging**, **Require approvals** и
   **Require status checks to pass before merging**.
3. Выберите обязательные проверки `quality`, `conventional-commit` и
   `Analyze JavaScript`; включите **Require branches to be up to date**.
4. Запретите force push и удаление ветки. Не включайте bypass для
   администраторов, если CI должен быть непреодолимым барьером.
5. В **Settings → Code security and analysis** включите Dependabot alerts,
   Dependabot security updates, secret scanning и push protection. CodeQL уже
   запускается workflow-ом.
6. В **Settings → General → Pull Requests** включите **Allow auto-merge**.
   Workflow авто-слияния применяется только к PR от Dependabot; GitHub всё равно
   дождётся обязательных проверок и правил защиты ветки.

## Vercel

1. В Vercel импортируйте проект или создайте его через CLI, а затем сохраните
   `VERCEL_TOKEN`, `VERCEL_ORG_ID` и `VERCEL_PROJECT_ID` в GitHub Actions
   secrets.
2. Сохраните production environment variables в Vercel: `GITHUB_TOKEN`, `KV_REST_API_URL` и `KV_REST_API_TOKEN` (либо совместимую пару `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`); `STEAM_API_KEY` нужен только для Steam endpoint. Не добавляйте значения секретов в GitHub или репозиторий. Без KV/Upstash credentials production API намеренно не запускается; без provider key соответствующий endpoint отвечает HTTP 503.
3. Workflow `Deploy production` запускается после успешного workflow `Quality`
   на `main`, собирает и публикует production deployment через Vercel CLI.
   После публикации он запрашивает `/api/github-status?username=octocat` и
   проверяет HTTP 200, заголовок `image/svg+xml` и SVG-тело. Убедитесь, что
   GitHub Actions secrets `VERCEL_TOKEN`, `VERCEL_ORG_ID` и `VERCEL_PROJECT_ID`
   существуют, а environment `production` разрешает workflow deployment.

## Rate limiting и IP

Код не принимает `X-Forwarded-For` напрямую как идентификатор клиента, поскольку
этот заголовок можно подделать, если доверять ему без проверки прокси. В API
используется `req.ip`, а при его отсутствии — адрес сокета. При подключении нового
reverse proxy проверьте, что платформа корректно выставляет `req.ip`; не включайте
`trust proxy = true` для произвольных прокси. Production лимиты хранятся в KV/Redis
и общие для инстансов, локальный Express использует память одного процесса.

## Релизы

`Release` запускается после push в `main`, повторяет `npm run check` и затем
запускает semantic-release. По Conventional Commits он рассчитывает следующую
версию, создаёт Git tag, GitHub Release и автоматически сформированные release
notes. Версию в `package.json`, tag и changelog вручную изменять не нужно.
