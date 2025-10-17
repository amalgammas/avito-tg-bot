import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import type { OzonSupplyTask } from '@bot/ozon/ozon-supply.types';

export interface SupplyOrderItem {
  article: string;
  quantity: number;
  sku?: number;
}

export type SupplyOrderStatus = 'task' | 'supply';

@Entity({ name: 'supply_orders' })
@Index('IDX_supply_orders_chat_created', ['chatId', 'createdAt'])
@Index('IDX_supply_orders_status', ['status'])
export class SupplyOrderEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  chatId!: string;

  @Column({ type: 'text', default: 'supply' })
  status!: SupplyOrderStatus;

  @Column({ type: 'text', nullable: true })
  taskId?: string;

  @Column({ type: 'text', nullable: true })
  operationId?: string;

  @Column({ type: 'text', nullable: true })
  arrival?: string;

  @Column({ type: 'text', nullable: true })
  warehouse?: string;

  @Column({ type: 'integer', nullable: true })
  clusterId?: number;

  @Column({ type: 'text', nullable: true })
  clusterName?: string;

  @Column({ type: 'integer', nullable: true })
  warehouseId?: number;

  @Column({ type: 'text', nullable: true })
  warehouseName?: string;

  @Column({ type: 'integer', nullable: true })
  dropOffId?: number;

  @Column({ type: 'text', nullable: true })
  dropOffName?: string;

  @Column({ type: 'integer', nullable: true })
  readyInDays?: number;

  @Column({ type: 'boolean', default: false })
  warehouseAutoSelect!: boolean;

  @Column({ type: 'boolean', default: true })
  timeslotAutoSelect!: boolean;

  @Column({ type: 'text', nullable: true })
  timeslotFrom?: string;

  @Column({ type: 'text', nullable: true })
  timeslotTo?: string;

  @Column({ type: 'simple-json', nullable: true })
  taskPayload?: OzonSupplyTask;

  @Column({ type: 'simple-json' })
  items!: SupplyOrderItem[];

  @Column({ type: 'integer' })
  createdAt!: number;

  @Column({ type: 'integer', nullable: true })
  updatedAt?: number;

  @Column({ type: 'integer', nullable: true })
  completedAt?: number;
}
