# Switchboard

Локальний оркестратор для двох кодинг-агентів (Claude Code і Antigravity `agy`): показує ліміти, розподіляє задачі й передає їх іншому агентові, коли в першого закінчується ліміт. Мерж у `main` і деплой робиш лише ти.

> Статус: **Етап 1 з 5** (ліміти + `sb status`). Повний README з усіма командами буде наприкінці.
> Результати розвідки: [docs/recon.md](docs/recon.md).

## Встановлення

Потрібні Node.js 20+ і pnpm (`corepack enable`), встановлені й залогінені `claude` та `agy`.

```bash
git clone https://github.com/olexlebid/switchboard
cd switchboard
pnpm install
pnpm sb status
```

## Команди (зараз)

| Команда | Що робить |
|---|---|
| `pnpm sb status` | Читає свіжі ліміти (`claude -p "/usage"`, `agy -p "/quota"`), зберігає в `~/.switchboard/state.json` і друкує статуси |
| `pnpm sb status --cached` | Показує останній збережений знімок без запитів до CLI |
| `pnpm sb status --json` | Те саме у JSON (для дешборду) |
| `pnpm sb hook install [--dry-run]` | Необов'язково: підключає statusLine-хук у `~/.claude/settings.json` (спершу робить бекап, існуючий statusLine обгортає) |
| `pnpm sb hook uninstall` | Повертає `statusLine` до стану до встановлення |
| `pnpm test` / `pnpm typecheck` | Тести й перевірка типів |

### Як відкотити зміни в `~/.claude/settings.json`

`sb hook install` кладе повну копію файлу поруч: `~/.claude/settings.json.sb-backup-<час>`. Відкат: `pnpm sb hook uninstall` (повертає лише ключ `statusLine`) або просто скопіюй бекап назад.
Хук корисний, лише якщо твоя версія Claude Code віддає `rate_limits` у statusLine JSON (у 2.1.286 цього поля немає), тому для статусу він не обов'язковий.

## Статуси

| Статус | Умова (пороги в `switchboard.config.yaml`) |
|---|---|
| доступно | усі вікна нижче `low` (60%) |
| мало | будь-яке вікно ≥ `low` |
| резерв | тижневе ≥ `weeklyReserve` (75%) |
| вичерпано | вікно ≥ `exhausted` (90%) або свіжий реактивний сигнал про ліміт |
| невідомо | даних немає або вони старші за `limits.staleAfterMin` (30 хв) |

Вікно, час скидання якого вже минув, вважається порожнім (0%). Для `agy` відсотки беруться з групи моделей із найменшим використанням (агент доступний, поки є хоча б одна група з запасом); вибір моделі з потрібної групи зробить роутер на Етапі 4.

## Дані й приватність

Стан лежить у `~/.switchboard/` (права `0600`, поза git). Email показується замаскованим (`ole…@gmail.com`), токени в логи не потрапляють (`packages/core/mask.ts`).
