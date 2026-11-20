import { StrictMode } from 'react';
import * as ReactDOM from 'react-dom/client';
import { bootstrap } from './bootstrap';
import './styles.css';

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);

bootstrap().then(element => root.render(<StrictMode>{element}</StrictMode>));
