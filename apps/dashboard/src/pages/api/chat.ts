// POST /api/chat: chat actions. `op` is one of new | send | stop | mode | select | retry.
import type { APIRoute } from 'astro';
import { selectChat } from '@core/chat-overview';
import { loadConfig } from '@core/config';
import { newChatFromDashboard, retryChat, sendChatMessage, setChatModeFromDashboard, stopChat } from '@core/launch';
import { badRequest, field, guard, json, respond, uploadsOf } from '../../api';

export const POST: APIRoute = async ({ request }) => {
  const denied = guard(request);
  if (denied) return denied;
  const form = await request.formData();
  const op = field(form, 'op');
  const cfg = loadConfig();
  if (op === 'new') return respond(await newChatFromDashboard(cfg, field(form, 'project'), field(form, 'mode') || 'auto'));

  // Chat ids look like c-20261001-074201-k3f; anything else is rejected before touching the state.
  const chat = field(form, 'chat');
  if (!/^c-[\w-]{1,40}$/.test(chat)) return badRequest();
  switch (op) {
    case 'send':
      return respond(await sendChatMessage(cfg, chat, field(form, 'text'), await uploadsOf(form)));
    case 'stop':
      return respond(stopChat(chat));
    case 'mode':
      return respond(setChatModeFromDashboard(chat, field(form, 'mode')));
    case 'retry':
      return respond(await retryChat(cfg, chat));
    case 'select':
      return selectChat(chat) ? json({ ok: true }) : json({ ok: false, error: 'Чату не існує.' }, 404);
    default:
      return badRequest();
  }
};
