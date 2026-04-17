import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { LoadingStateService } from './services/loading-state.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  styles: [`
    .overlay { position: fixed; inset: 0; background: rgba(248, 250, 252, 0.72); backdrop-filter: blur(3px); display: grid; place-items: center; z-index: 1000; }
    .spinner { width: 44px; height: 44px; border-radius: 50%; border: 3px solid rgba(15, 23, 42, 0.12); border-top-color: var(--accent); animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  `],
  template: `
    @if (loading.visible()) {
      <div class="overlay">
        <div class="spinner"></div>
      </div>
    }
    <router-outlet />
  `,
})
export class AppComponent {
  readonly loading = inject(LoadingStateService);
}
