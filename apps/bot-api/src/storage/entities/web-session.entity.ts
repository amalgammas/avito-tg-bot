import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({ name: 'web_sessions' })
@Index('IDX_web_sessions_user', ['userId'])
@Index('IDX_web_sessions_expires', ['expiresAt'])
export class WebSessionEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  userId!: string;

  @Column({ type: 'text' })
  sessionHash!: string;

  @Column({ type: 'integer' })
  expiresAt!: number;

  @Column({ type: 'integer' })
  createdAt!: number;

  @Column({ type: 'integer' })
  lastSeenAt!: number;
}
