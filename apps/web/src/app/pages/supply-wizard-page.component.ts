import { JsonPipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '../services/api.service';
import { NavigationStateService } from '../services/navigation-state.service';

interface ParsedWizardTask {
  id: string;
  stage: string;
  supplyType: string;
  clusterType: string | null;
  dropOffSearchQuery: string | null;
  dropOffOptions: Array<{ warehouseId: number; name: string; address?: string; type?: string }>;
  clusterOptions: Array<{ id: number; name: string; macrolocalClusterId?: number }>;
  warehouseOptions: Array<{ warehouseId: number; name: string }>;
  selectedDropOffId: number | null;
  selectedDropOffName: string | null;
  selectedClusterId: number | null;
  selectedClusterName: string | null;
  selectedWarehouseId: number | null;
  selectedWarehouseName: string | null;
  autoWarehouseSelection: boolean;
  readyInDays: number | null;
  lastDay: string | null;
  source: string;
  task: {
    taskId: string;
    supplyType: string;
    items: Array<{ article: string; sku?: number; quantity: number }>;
    itemCount: number;
    totalQuantity: number;
  };
}

@Component({
  standalone: true,
  imports: [ReactiveFormsModule, JsonPipe],
  styles: [`
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 20px; padding: 24px; box-shadow: var(--shadow); max-width: 920px; }
    .note { color: var(--text-muted); line-height: 1.6; }
    .field { margin: 18px 0; }
    label { display: block; margin-bottom: 8px; font-weight: 600; }
    input { width: 100%; padding: 14px 16px; border: 1px solid var(--border); border-radius: 12px; }
    .actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 12px; }
    button { padding: 12px 16px; border-radius: 12px; border: 0; background: var(--accent); color: #fff; cursor: pointer; }
    .error { color: var(--danger); margin-top: 12px; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 16px; background: #f8fafc; border-radius: 12px; border: 1px solid var(--border); }
    .chips { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
    .chips button { background: #fff; color: var(--text); border: 1px solid var(--border); }
    .chips button.active { background: var(--accent); color: #fff; border-color: var(--accent); }
    .option-list { display: grid; gap: 10px; margin-top: 16px; }
    .option-list.two-columns { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .summary-list { display: grid; gap: 10px; margin: 18px 0; }
    .summary { padding: 14px 16px; border-radius: 14px; border: 1px solid var(--border); background: #f8fafc; }
    .summary strong { display: block; margin-bottom: 4px; }
    .option { text-align: left; padding: 14px; border-radius: 14px; border: 1px solid var(--border); background: #fff; cursor: pointer; color: black !important; }
    .option strong { display: block; margin-bottom: 4px; }
    .inline-note { margin-top: 12px; color: var(--text-muted); }
    .hour-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
    .hour-grid button { background: #fff; color: var(--text); border: 1px solid var(--border); }
    .hour-grid button.active { background: var(--accent); color: #fff; border-color: var(--accent); }
    @media (max-width: 760px) {
      .option-list.two-columns { grid-template-columns: 1fr; }
      .hour-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }
  `],
  template: `
    <section class="card">
      <h1>Новая поставка</h1>
      <p class="note">Шаги мастера постепенно сворачиваются в summary сверху, чтобы экран не превращался в бесконечный лист.</p>

      @if (!preview()) {
        <form [formGroup]="form" (ngSubmit)="submit()">
          <div class="field">
            <label for="spreadsheetUrl">Google Sheets URL</label>
            <input id="spreadsheetUrl" type="text" formControlName="spreadsheetUrl" placeholder="https://docs.google.com/spreadsheets/d/...">
          </div>
          <div class="field">
            <label for="file">Или Excel файл</label>
            <input id="file" type="file" accept=".xlsx" (change)="onFileSelected($event)">
          </div>
          <div class="actions">
            <button type="submit" [disabled]="loading()">Разобрать файл</button>
          </div>
        </form>
      }

      @if (error()) {
        <div class="error">{{ error() }}</div>
      }

      @if (preview()) {
        <div class="summary-list">
          <div class="summary">
            <strong>Файл</strong>
            {{ preview()!.source }} · {{ preview()!.task.itemCount }} SKU / {{ preview()!.task.totalQuantity }} шт.
          </div>
          <div class="summary">
            <strong>Тип поставки</strong>
            {{ preview()!.supplyType === 'CREATE_TYPE_DIRECT' ? 'Direct' : 'Crossdock' }}
          </div>
          @if (preview()!.selectedDropOffName) {
            <div class="summary">
              <strong>Пункт сдачи</strong>
              {{ preview()!.selectedDropOffName }}
            </div>
          }
          @if (preview()!.selectedClusterName) {
            <div class="summary">
              <strong>Кластер</strong>
              {{ preview()!.selectedClusterName }}
            </div>
          }
          @if (preview()!.autoWarehouseSelection || preview()!.selectedWarehouseName || preview()!.selectedWarehouseId) {
            <div class="summary">
              <strong>Склад</strong>
              {{ preview()!.autoWarehouseSelection ? 'Первый доступный склад' : (preview()!.selectedWarehouseName || preview()!.selectedWarehouseId) }}
            </div>
          }
          @if (effectiveReadyInDays() !== null) {
            <div class="summary">
              <strong>Готовность</strong>
              {{ effectiveReadyInDays() }} дн.
            </div>
          }
          @if (effectiveLastDayLabel()) {
            <div class="summary">
              <strong>Крайняя дата</strong>
              {{ effectiveLastDayLabel() }}
            </div>
          }
          @if (timeslotWindowLabel()) {
            <div class="summary">
              <strong>Окно слотов</strong>
              {{ timeslotWindowLabel() }}
            </div>
          }
        </div>

        @if (showPreview()) {
          <h2>Предпросмотр</h2>
          <pre>{{ preview()!.task.items | json }}</pre>
        }

        @if (showSupplyType()) {
          <h2>Тип поставки</h2>
          <div class="chips">
            <button type="button" [class.active]="preview()!.supplyType === 'CREATE_TYPE_CROSSDOCK'" (click)="setSupplyType('CREATE_TYPE_CROSSDOCK')">Crossdock</button>
            <button type="button" [class.active]="preview()!.supplyType === 'CREATE_TYPE_DIRECT'" (click)="setSupplyType('CREATE_TYPE_DIRECT')">Direct</button>
          </div>
        }

        @if (showDropOffSearch()) {
          <h2>Поиск drop-off</h2>
          <p>Выберите точку отправки</p>
          <div class="field">
            <label for="dropOffQuery">Запрос</label>
            <input id="dropOffQuery" type="text" [value]="dropOffQuery()" (input)="onDropOffQuery($event)">
          </div>
          <div class="actions">
            <button type="button" (click)="searchDropOffs()" [disabled]="loading()">Найти drop-off</button>
          </div>
          @if (preview()!.dropOffOptions.length) {
            <div class="option-list">
              @for (option of preview()!.dropOffOptions; track option.warehouseId) {
                <button class="option" type="button" (click)="selectDropOff(option.warehouseId)">
                  <strong>{{ option.name }}</strong>
                  <span>{{ option.address || ('ID ' + option.warehouseId) }}</span>
                </button>
              }
            </div>
          }
        }

        @if (showClusterType()) {
          <h2>Регион кластера</h2>
          <div class="chips">
            <button type="button" [class.active]="preview()!.clusterType === 'CLUSTER_TYPE_OZON'" (click)="setClusterType('CLUSTER_TYPE_OZON')">Россия</button>
            <button type="button" [class.active]="preview()!.clusterType === 'CLUSTER_TYPE_CIS'" (click)="setClusterType('CLUSTER_TYPE_CIS')">СНГ</button>
          </div>
        }

        @if (showClusters()) {
          <h2>Выбор кластера</h2>
          <div class="option-list two-columns">
            @for (cluster of preview()!.clusterOptions; track cluster.id) {
              <button class="option" type="button" (click)="selectCluster(cluster.id)">
                <strong>{{ cluster.name }}</strong>
                <span>ID {{ cluster.id }}</span>
              </button>
            }
          </div>
        }

        @if (showWarehouses()) {
          <h2>Выбор склада</h2>
          <div class="actions">
            <button type="button" (click)="selectWarehouseAuto()">Первый доступный склад</button>
          </div>
          @if (preview()!.warehouseOptions.length) {
            <div class="option-list two-columns">
              @for (warehouse of preview()!.warehouseOptions; track warehouse.warehouseId) {
                <button class="option" type="button" (click)="selectWarehouse(warehouse.warehouseId)">
                  <strong>{{ warehouse.name }}</strong>
                  <span>ID {{ warehouse.warehouseId }}</span>
                </button>
              }
            </div>
          }
        }

        @if (showReadyDays()) {
          <h2>Готовность к отгрузке</h2>
          <p class="note">Выберите, через сколько дней будете готовы к отгрузке.</p>
          <div class="chips">
            @for (days of [0, 1, 2, 3, 5, 7, 14, 21, 28]; track days) {
              <button type="button" [class.active]="readyInDays() === days" (click)="setReadyDays(days)">{{ days }} дн.</button>
            }
          </div>
          <div class="field">
            <label for="readyDaysInput">Или своё значение от 0 до 28</label>
            <input id="readyDaysInput" type="number" min="0" max="28" [value]="readyInDays() ?? ''" (input)="onReadyDaysInput($event)">
          </div>
        }

        @if (showDeadline()) {
          <h2>Крайняя дата</h2>
          <p class="note">Укажите дату, не позже которой должен быть найден слот. Если до этой даты слот не найдётся, задача остановится.</p>
          <div class="chips">
            @for (option of deadlineOptions(); track option.value) {
              <button type="button" [class.active]="deadlineInput() === option.value" (click)="selectDeadline(option.value)">
                {{ option.label }}
              </button>
            }
          </div>
          <div class="field">
            <label for="deadlineInput">Или выберите дату вручную</label>
            <input id="deadlineInput" type="date" [min]="deadlineMin()" [max]="deadlineMax()" [value]="deadlineInput()" (input)="onDeadlineInput($event)">
          </div>
          <div class="inline-note">Допустимый диапазон: от {{ deadlineMinLabel() }} до {{ deadlineMaxLabel() }}.</div>
        }

        @if (showTimeslotWindow()) {
          <h2>Часы поиска</h2>
          <p class="note">Как и в Telegram, можно искать первый доступный слот или ограничить поиск диапазоном часов.</p>
          <div class="chips">
            <button type="button" [class.active]="timeslotFirstAvailable()" (click)="selectTimeslotFirstAvailable()">Первый доступный</button>
            <button type="button" [class.active]="!timeslotFirstAvailable()" (click)="selectTimeslotByHour()">Выбрать часы</button>
          </div>

          @if (!timeslotFirstAvailable()) {
            <div class="field">
              <label>Начало поиска</label>
              <div class="hour-grid">
                @for (hour of hourOptions; track hour) {
                  <button type="button" [class.active]="timeslotFromHour() === hour" (click)="setTimeslotFromHour(hour)">
                    {{ formatHour(hour) }}
                  </button>
                }
              </div>
            </div>

            @if (timeslotFromHour() !== null) {
              <div class="field">
                <label>Конец поиска</label>
                <div class="hour-grid">
                  @for (hour of availableToHours(); track hour) {
                    <button type="button" [class.active]="timeslotToHour() === hour" (click)="setTimeslotToHour(hour)">
                      {{ formatHour(hour) }}
                    </button>
                  }
                </div>
              </div>
            }
          }

          <div class="actions">
            <button type="button" (click)="submitDraft()" [disabled]="loading() || !canSubmit()">Запустить задачу</button>
          </div>
        }

        @if (preview()!.stage === 'processingStarted') {
          <p class="note">Задача запущена. Она должна появиться в списке задач. Отмена должна быть доступна из списка и карточки задачи.</p>
        }
      }
    </section>
  `,
})
export class SupplyWizardPageComponent {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly navigationState = inject(NavigationStateService);

  readonly loading = signal(false);
  readonly error = signal('');
  readonly preview = signal<ParsedWizardTask | null>(null);
  readonly dropOffQuery = signal('');
  readonly readyInDays = signal<number | null>(null);
  readonly deadlineInput = signal('');
  readonly timeslotFirstAvailable = signal(true);
  readonly timeslotFromHour = signal<number | null>(null);
  readonly timeslotToHour = signal<number | null>(null);
  private selectedFile?: File;
  readonly hourOptions = Array.from({ length: 24 }, (_, index) => index);

  readonly form = this.fb.nonNullable.group({
    spreadsheetUrl: [''],
  });

  readonly showPreview = computed(() => (this.preview()?.stage ?? '') === 'parsed');
  readonly showSupplyType = computed(() => ['parsed', 'awaitDropOffQuery', 'dropOffSelect'].includes(this.preview()?.stage ?? ''));
  readonly showDropOffSearch = computed(() => this.preview()?.supplyType === 'CREATE_TYPE_CROSSDOCK' && ['awaitDropOffQuery', 'dropOffSelect'].includes(this.preview()?.stage ?? ''));
  readonly showClusterType = computed(() => (this.preview()?.stage ?? '') === 'clusterTypeSelect');
  readonly showClusters = computed(() => (this.preview()?.stage ?? '') === 'clusterSelect' && Boolean(this.preview()?.clusterOptions.length));
  readonly showWarehouses = computed(() => (this.preview()?.stage ?? '') === 'warehouseSelect');
  readonly showReadyDays = computed(() => this.preview()?.stage === 'readyDaysPending');
  readonly showDeadline = computed(() => this.preview()?.stage === 'readyDaysPending' && this.readyInDays() !== null);
  readonly showTimeslotWindow = computed(() => this.preview()?.stage === 'readyDaysPending' && Boolean(this.deadlineInput()));
  readonly effectiveReadyInDays = computed(() => this.preview()?.readyInDays ?? this.readyInDays());
  readonly effectiveLastDayLabel = computed(() => this.formatDateLabel(this.preview()?.lastDay ?? this.deadlineInput()));
  readonly timeslotWindowLabel = computed(() => {
    if (this.timeslotFirstAvailable()) {
      return 'Первый доступный';
    }
    const fromHour = this.timeslotFromHour();
    const toHour = this.timeslotToHour();
    if (fromHour === null) {
      return null;
    }
    if (toHour === null) {
      return `с ${this.formatHour(fromHour)} до конца дня`;
    }
    return `${this.formatHour(fromHour)}-${this.formatHour(toHour)}`;
  });
  readonly deadlineOptions = computed(() => {
    const ready = this.readyInDays();
    if (ready === null) {
      return [];
    }

    const offsets = [ready, ready + 3, ready + 7, ready + 14, ready + 21, ready + 27]
      .filter((value, index, items) => value <= 28 && items.indexOf(value) === index);

    return offsets.map((offset) => ({
      value: this.dateInputFromOffset(offset),
      label: `до ${this.formatDateLabel(this.dateInputFromOffset(offset))}`,
    }));
  });
  readonly deadlineMin = computed(() => {
    const ready = this.readyInDays();
    return ready === null ? '' : this.dateInputFromOffset(ready);
  });
  readonly deadlineMax = computed(() => this.dateInputFromOffset(28));
  readonly deadlineMinLabel = computed(() => this.formatDateLabel(this.deadlineMin()));
  readonly deadlineMaxLabel = computed(() => this.formatDateLabel(this.deadlineMax()));
  readonly availableToHours = computed(() => {
    const fromHour = this.timeslotFromHour();
    if (fromHour === null) {
      return this.hourOptions;
    }
    return this.hourOptions.filter((hour) => hour >= fromHour);
  });

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement | null;
    this.selectedFile = input?.files?.[0] ?? undefined;
  }

  async submit() {
    this.loading.set(true);
    this.error.set('');
    this.preview.set(null);

    try {
      const body = new FormData();
      const spreadsheetUrl = this.form.getRawValue().spreadsheetUrl.trim();
      if (spreadsheetUrl) {
        body.append('spreadsheetUrl', spreadsheetUrl);
      }
      if (this.selectedFile) {
        body.append('file', this.selectedFile);
      }
      this.preview.set(this.normalizePreview(await firstValueFrom(this.api.post<ParsedWizardTask>('/api/web/wizard/parse-spreadsheet', body))));
      this.dropOffQuery.set('');
      this.readyInDays.set(null);
      this.deadlineInput.set('');
      this.resetTimeslotWindow();
    } catch (error: any) {
      this.error.set(error?.error?.message ?? 'Не удалось разобрать spreadsheet.');
    } finally {
      this.loading.set(false);
    }
  }

  async setSupplyType(supplyType: 'CREATE_TYPE_CROSSDOCK' | 'CREATE_TYPE_DIRECT') {
    const current = this.preview();
    if (!current) return;
    this.preview.set(this.normalizePreview(await firstValueFrom(this.api.put<ParsedWizardTask>(`/api/web/wizard/drafts/${current.id}/supply-type`, { supplyType }))));
  }

  async setClusterType(clusterType: 'CLUSTER_TYPE_OZON' | 'CLUSTER_TYPE_CIS') {
    const current = this.preview();
    if (!current) return;
    this.preview.set(this.normalizePreview(await firstValueFrom(this.api.put<ParsedWizardTask>(`/api/web/wizard/drafts/${current.id}/cluster-type`, { clusterType }))));
  }

  onDropOffQuery(event: Event) {
    const input = event.target as HTMLInputElement | null;
    this.dropOffQuery.set(input?.value ?? '');
  }

  async searchDropOffs() {
    const current = this.preview();
    if (!current) return;
    this.preview.set(this.normalizePreview(await firstValueFrom(this.api.post<ParsedWizardTask>(`/api/web/wizard/drafts/${current.id}/drop-off-search`, { query: this.dropOffQuery() }))));
  }

  async selectDropOff(dropOffId: number) {
    const current = this.preview();
    if (!current) return;
    this.preview.set(this.normalizePreview(await firstValueFrom(this.api.put<ParsedWizardTask>(`/api/web/wizard/drafts/${current.id}/drop-off`, { dropOffId }))));
  }

  async selectCluster(clusterId: number) {
    const current = this.preview();
    if (!current) return;
    this.preview.set(this.normalizePreview(await firstValueFrom(this.api.put<ParsedWizardTask>(`/api/web/wizard/drafts/${current.id}/cluster`, { clusterId }))));
  }

  async selectWarehouse(warehouseId: number) {
    const current = this.preview();
    if (!current) return;
    this.preview.set(this.normalizePreview(await firstValueFrom(this.api.put<ParsedWizardTask>(`/api/web/wizard/drafts/${current.id}/warehouse`, { warehouseId }))));
  }

  async selectWarehouseAuto() {
    const current = this.preview();
    if (!current) return;
    this.preview.set(this.normalizePreview(await firstValueFrom(this.api.put<ParsedWizardTask>(`/api/web/wizard/drafts/${current.id}/warehouse`, { autoSelect: true }))));
  }

  setReadyDays(days: number) {
    this.readyInDays.set(days);
    this.syncDeadlineWithReadyDays(days);
    this.resetTimeslotWindow();
  }

  onReadyDaysInput(event: Event) {
    const input = event.target as HTMLInputElement | null;
    const value = Number(input?.value ?? this.readyInDays() ?? 0);
    const normalized = Number.isFinite(value) && value >= 0 && value <= 28 ? Math.floor(value) : null;
    this.readyInDays.set(normalized);
    this.syncDeadlineWithReadyDays(normalized);
    this.resetTimeslotWindow();
  }

  selectDeadline(value: string) {
    this.deadlineInput.set(value);
  }

  onDeadlineInput(event: Event) {
    const input = event.target as HTMLInputElement | null;
    this.deadlineInput.set(input?.value ?? '');
  }

  selectTimeslotFirstAvailable() {
    this.timeslotFirstAvailable.set(true);
    this.timeslotFromHour.set(null);
    this.timeslotToHour.set(null);
  }

  selectTimeslotByHour() {
    this.timeslotFirstAvailable.set(false);
  }

  setTimeslotFromHour(hour: number) {
    this.timeslotFirstAvailable.set(false);
    this.timeslotFromHour.set(hour);
    if (this.timeslotToHour() !== null && this.timeslotToHour()! < hour) {
      this.timeslotToHour.set(null);
    }
  }

  setTimeslotToHour(hour: number) {
    this.timeslotFirstAvailable.set(false);
    this.timeslotToHour.set(hour);
  }

  async submitDraft() {
    const current = this.preview();
    const readyInDays = this.readyInDays();
    if (!current || readyInDays === null || !this.canSubmit()) return;
    this.loading.set(true);
    this.error.set('');

    try {
      this.preview.set(this.normalizePreview(await firstValueFrom(this.api.post<ParsedWizardTask>(`/api/web/wizard/drafts/${current.id}/submit`, {
        readyInDays,
        lastDay: this.deadlineInput(),
        timeslotFirstAvailable: this.timeslotFirstAvailable(),
        timeslotFromHour: this.timeslotFirstAvailable() ? undefined : (this.timeslotFromHour() ?? undefined),
        timeslotToHour: this.timeslotFirstAvailable() ? undefined : (this.timeslotToHour() ?? undefined),
      }))));
      this.navigationState.markSuppliesPresent();
      await this.router.navigate(['/supplies'], { state: { created: true } });
    } catch (error: any) {
      this.error.set(error?.error?.message ?? 'Не удалось запустить задачу.');
    } finally {
      this.loading.set(false);
    }
  }

  private normalizePreview(value: ParsedWizardTask): ParsedWizardTask {
    return {
      ...value,
      clusterType: value.clusterType ?? null,
      dropOffSearchQuery: value.dropOffSearchQuery ?? null,
      dropOffOptions: Array.isArray(value.dropOffOptions) ? value.dropOffOptions : [],
      clusterOptions: Array.isArray(value.clusterOptions) ? value.clusterOptions : [],
      warehouseOptions: Array.isArray(value.warehouseOptions) ? value.warehouseOptions : [],
      selectedDropOffId: value.selectedDropOffId ?? null,
      selectedDropOffName: value.selectedDropOffName ?? null,
      selectedClusterId: value.selectedClusterId ?? null,
      selectedClusterName: value.selectedClusterName ?? null,
      selectedWarehouseId: value.selectedWarehouseId ?? null,
      selectedWarehouseName: value.selectedWarehouseName ?? null,
      autoWarehouseSelection: value.autoWarehouseSelection ?? false,
      readyInDays: value.readyInDays ?? null,
      lastDay: value.lastDay ?? null,
    };
  }

  private syncDeadlineWithReadyDays(readyInDays: number | null) {
    if (readyInDays === null) {
      this.deadlineInput.set('');
      return;
    }

    const current = this.deadlineInput();
    if (!current) {
      return;
    }

    const min = this.dateInputFromOffset(readyInDays);
    const max = this.dateInputFromOffset(28);
    if (current < min || current > max) {
      this.deadlineInput.set('');
    }
  }

  private resetTimeslotWindow() {
    this.timeslotFirstAvailable.set(true);
    this.timeslotFromHour.set(null);
    this.timeslotToHour.set(null);
  }

  canSubmit(): boolean {
    if (!this.deadlineInput()) {
      return false;
    }
    if (this.timeslotFirstAvailable()) {
      return true;
    }
    return this.timeslotFromHour() !== null && this.timeslotToHour() !== null;
  }

  private dateInputFromOffset(daysOffset: number): string {
    const date = new Date();
    date.setDate(date.getDate() + daysOffset);
    return date.toISOString().slice(0, 10);
  }

  private formatDateLabel(value?: string | null): string | null {
    if (!value) {
      return null;
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }

    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: 'Europe/Moscow',
    }).format(parsed);
  }

  formatHour(hour: number): string {
    return `${hour.toString().padStart(2, '0')}:00`;
  }
}
