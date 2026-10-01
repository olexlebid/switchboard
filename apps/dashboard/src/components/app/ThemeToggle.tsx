// Light / dark / system switch (shadcn dark-mode recipe: a `dark` class on <html>).
import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect } from 'react';
import { useStoredString } from '@/hooks/use-dashboard';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

export function ThemeToggle() {
  const [theme = 'system', setTheme] = useStoredString('sb-theme');

  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && media.matches));
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label="Тема оформлення">
          <Sun className="size-4 dark:hidden" aria-hidden="true" />
          <Moon className="hidden size-4 dark:block" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light"><Sun aria-hidden="true" /> Світла</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark"><Moon aria-hidden="true" /> Темна</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system"><Monitor aria-hidden="true" /> Системна</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
