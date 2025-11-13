import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({ name: 'wizard_sessions' })
@Index('IDX_wizard_sessions_chat', ['chatId'])
@Index('IDX_wizard_sessions_task', ['taskId'])
export class WizardSessionEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  chatId!: string;

  @Column({ type: 'text', nullable: true })
  taskId?: string | null;

  @Column({ type: 'text' })
  stage!: string;

  @Column({ type: 'simple-json' })
  payload!: unknown;

  @Column({ type: 'integer' })
  createdAt!: number;

  @Column({ type: 'integer' })
  updatedAt!: number;
}
