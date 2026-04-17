import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({ name: 'web_auth_tokens' })
@Index('IDX_web_auth_tokens_user', ['userId'])
@Index('IDX_web_auth_tokens_expires', ['expiresAt'])
export class WebAuthTokenEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  userId!: string;

  @Column({ type: 'text' })
  tokenHash!: string;

  @Column({ type: 'integer' })
  expiresAt!: number;

  @Column({ type: 'integer' })
  createdAt!: number;

  @Column({ type: 'integer', nullable: true })
  consumedAt?: number;
}
