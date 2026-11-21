import { shallowRef } from 'vue';

export const SEASONS = [
  { id: 'spring', name: '春山新雨', season: '春', palette: ['#EEF4ED', '#386845'] },
  { id: 'summer', name: '夏花流火', season: '夏', palette: ['#FFE9DB', '#A71B19', '#FFAD68'] },
  { id: 'autumn', name: '秋庭鎏金', season: '秋', palette: ['#F3EFE7', '#9A6A35'] },
  { id: 'winter', name: '凛冬初雪', season: '冬', palette: ['#FFFFFF', '#EEEEEE', '#383838'] }
] as const;

export const ACCENTS = {
  zhe: { label: '赭石', light: ['#9a6a35', '#805326'], dark: ['#c59865', '#deb17d'] },
  lan: { label: '黛蓝', light: ['#5b6b9e', '#42507c'], dark: ['#93a7d6', '#aebde4'] },
  yu: { label: '青玉', light: ['#3f7d5c', '#2f5f46'], dark: ['#79b788', '#9ccaa8'] },
  jiang: { label: '绛红', light: ['#a85555', '#7f3d3d'], dark: ['#dd8d8d', '#e9a9a9'] },
  jin: { label: '金褐', light: ['#a3762a', '#7c5820'], dark: ['#d3a45f', '#e3bb7d'] }
} as const;

type Season = typeof SEASONS[number]['id'];
type Accent = keyof typeof ACCENTS | 'season';
type Theme = 'system' | 'light' | 'dark';
type Effects = 'standard' | 'lite';
interface Appearance {
  'ui.season': Season;
  theme: Theme;
  'ui.accentChoice': Accent;
  'ui.effects': Effects;
  'ui.fontScale': string;
}

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const appearanceState = shallowRef<Appearance>({
  'ui.season': 'autumn', theme: 'system', 'ui.accentChoice': 'season',
  'ui.effects': 'standard', 'ui.fontScale': '1'
});
export const appearance = appearanceState;

function luminance(hex: string): number {
  const components = hex.slice(1).match(/../g)!.map(part => parseInt(part, 16) / 255);
  const [red, green, blue] = components.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return red! * 0.2126 + green! * 0.7152 + blue! * 0.0722;
}

function applyAppearance(): void {
  const values = appearance.value;
  const dark = values.theme === 'dark' || (values.theme === 'system' && systemDark.matches);
  const mode = dark ? 'dark' : 'light';
  const root = document.documentElement;
  root.dataset.themePreference = values.theme;
  root.dataset.theme = mode;
  root.dataset.season = values['ui.season'];
  root.dataset.effects = values['ui.effects'];
  root.style.colorScheme = mode;
  root.style.setProperty('--font-scale', values['ui.fontScale']);

  for (const property of ['--accent', '--accent-strong', '--on-accent', '--accent-soft']) root.style.removeProperty(property);
  const accent = values['ui.accentChoice'];
  if (accent === 'season') return;
  const [base, strong] = ACCENTS[accent][mode];
  root.style.setProperty('--accent', base);
  root.style.setProperty('--accent-strong', strong);
  root.style.setProperty('--on-accent', luminance(base) > 0.179 ? '#000000' : '#ffffff');
  root.style.setProperty('--accent-soft', 'color-mix(in srgb, var(--accent) 14%, var(--surface))');
}

function readAppearance(values: Record<string, string>): void {
  const legacyAccent = values['ui.accent'] ?? localStorage.getItem('ui.accent');
  const accent = values['ui.accentChoice'] ?? (legacyAccent === 'zhe' ? 'season' : legacyAccent);
  const mode = values.theme;
  const scale = Number(values['ui.fontScale']) || 1;
  appearanceState.value = {
    'ui.season': SEASONS.find(choice => choice.id === values['ui.season'])?.id ?? 'autumn',
    theme: mode === 'dark' || mode === 'light' ? mode : 'system',
    'ui.effects': values['ui.effects'] === 'lite' ? 'lite' : 'standard',
    'ui.accentChoice': accent && Object.hasOwn(ACCENTS, accent) ? accent as Accent : 'season',
    'ui.fontScale': String(Math.max(0.9, Math.min(1.5, scale)))
  };
  applyAppearance();
}

export async function initializeAppearance(): Promise<void> {
  let changed = false;
  const unsubscribe = window.desktop.settings.onAppearanceChanged(values => {
    changed = true;
    readAppearance(values);
  });
  systemDark.addEventListener('change', applyAppearance);
  window.addEventListener('beforeunload', () => {
    unsubscribe();
    systemDark.removeEventListener('change', applyAppearance);
  }, { once: true });
  const settings = await window.desktop.settings.list().catch(() => ({}));
  if (!changed) readAppearance(settings);
}

export async function saveAppearance<K extends keyof Appearance>(key: K, value: Appearance[K]): Promise<void> {
  if (!await window.desktop.settings.set(key, value)) throw new Error('设置存储未确认写入');
}
