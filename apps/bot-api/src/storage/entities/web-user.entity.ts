import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({ name: 'web_users' })
@Index('IDX_web_users_email', ['email'], { unique: true })
export class WebUserEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  email!: string;

  @Column({ type: 'integer' })
  createdAt!: number;

  @Column({ type: 'integer' })
  updatedAt!: number;

  @Column({ type: 'integer', nullable: true })
  lastLoginAt?: number;
}
