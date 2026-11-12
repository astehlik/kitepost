import './style.css';
import { initCore } from './wasm';
import { boot } from './ui/app';

await initCore();
await boot();
