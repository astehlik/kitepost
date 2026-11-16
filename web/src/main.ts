import './style.css';
import { initCore } from './wasm';
import { boot } from './ui/app';
import { watchForUpdates } from './ui/update';

watchForUpdates();
await initCore();
await boot();
