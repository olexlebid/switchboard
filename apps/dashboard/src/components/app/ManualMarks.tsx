// Hand-set marks for services without an API (not used by the router): one toggle row per card.
import type { ManualCardOverview } from '@core/overview';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type Props = { cards: ManualCardOverview[]; onChange: (id: string, state: 'available' | 'exhausted') => void };

export function ManualMarks({ cards, onChange }: Props) {
  if (cards.length === 0) return null;
  return (
    <section aria-labelledby="manual-heading" className="flex flex-wrap items-center gap-x-6 gap-y-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <h2 id="manual-heading" className="cursor-help text-sm font-medium">Ручні позначки</h2>
        </TooltipTrigger>
        <TooltipContent>Для сервісів без API. У роутингу не беруть участі.</TooltipContent>
      </Tooltip>
      {cards.map((card) => (
        <div key={card.id} role="group" aria-label={card.title} className="flex items-center gap-2 text-sm">
          <span>{card.title}</span>
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            value={card.state ?? ''}
            onValueChange={(v) => { if (v === 'available' || v === 'exhausted') onChange(card.id, v); }}
          >
            <ToggleGroupItem value="available">Доступно</ToggleGroupItem>
            <ToggleGroupItem value="exhausted">Вичерпано</ToggleGroupItem>
          </ToggleGroup>
          {card.at && (
            <time className="text-xs text-muted-foreground" dateTime={card.at}>
              {new Date(card.at).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' })}
            </time>
          )}
        </div>
      ))}
    </section>
  );
}
