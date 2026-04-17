import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '../services/api.service';

interface OzonCredentialsResponse {
  connected: boolean;
  clientId?: string;
  apiKey?: string;
  verifiedAt?: string;
  accessExpiresAt?: string;
}

@Component({
  standalone: true,
  imports: [ReactiveFormsModule],
  styles: [`
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 20px; padding: 24px; box-shadow: var(--shadow); max-width: 720px; }
    h1 { margin-top: 0; }
    .meta { margin: 0 0 24px; color: var(--text-muted); line-height: 1.5; }
    .field { margin-bottom: 16px; }
    label { display: block; margin-bottom: 8px; font-weight: 600; }
    input { width: 100%; padding: 14px 16px; border: 1px solid var(--border); border-radius: 12px; }
    .actions { display: flex; gap: 12px; }
    button { padding: 12px 16px; border-radius: 12px; border: 0; cursor: pointer; }
    .primary { background: var(--accent); color: #fff; }
    .secondary { background: #fff; border: 1px solid var(--border); }
    .status { margin-bottom: 16px; color: var(--text-muted); }
  `],
  template: `
    <section class="card">
      <h1>Настройки Ozon</h1>
      <p class="meta">Web-канал использует те же Ozon ключи, что и Telegram.</p>

      <div class="status">
        @if (state()?.connected) {
          Подключено. client_id: {{ state()?.clientId }}, api_key: {{ state()?.apiKey }}
        } @else {
          Ключи ещё не подключены.
        }
      </div>

      @if (state()?.connected && !editMode()) {
        <div class="actions">
          <button class="primary" type="button" (click)="openEditMode()">Обновить ключи</button>
        </div>
      } @else {
        <form [formGroup]="form" (ngSubmit)="save()">
          <div class="field">
            <label for="clientId">Client ID</label>
            <input id="clientId" type="text" formControlName="clientId" />
          </div>
          <div class="field">
            <label for="apiKey">API Key</label>
            <input id="apiKey" type="text" formControlName="apiKey" />
          </div>
          <div class="actions">
            <button class="primary" type="submit">Сохранить</button>
            @if (state()?.connected) {
              <button class="secondary" type="button" (click)="closeEditMode()">Отмена</button>
            } @else {
              <button class="secondary" type="button" (click)="clear()">Очистить</button>
            }
          </div>
        </form>
      }
    </section>
  `,
})
export class SettingsPageComponent {
  private readonly api = inject(ApiService);
  private readonly fb = inject(FormBuilder);
  readonly state = signal<OzonCredentialsResponse | null>(null);
  readonly editMode = signal(false);

  readonly form = this.fb.nonNullable.group({
    clientId: ['', Validators.required],
    apiKey: ['', Validators.required],
  });

  constructor() {
    queueMicrotask(() => void this.load());
  }

  async load() {
    this.state.set(await firstValueFrom(this.api.get<OzonCredentialsResponse>('/api/web/ozon-credentials')));
    this.editMode.set(!(this.state()?.connected ?? false));
  }

  async save() {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.state.set(
      await firstValueFrom(this.api.put<OzonCredentialsResponse>('/api/web/ozon-credentials', this.form.getRawValue())),
    );
    this.form.reset();
    this.editMode.set(false);
  }

  async clear() {
    this.state.set(await firstValueFrom(this.api.delete<OzonCredentialsResponse>('/api/web/ozon-credentials')));
    this.editMode.set(true);
  }

  openEditMode() {
    this.editMode.set(true);
  }

  closeEditMode() {
    this.form.reset();
    this.editMode.set(false);
  }
}
