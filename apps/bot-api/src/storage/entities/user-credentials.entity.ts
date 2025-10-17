import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'user_credentials' })
export class UserCredentialsEntity {
  @PrimaryColumn({ type: 'text' })
  chatId!: string;

  @Column({ type: 'text' })
  clientId!: string;

  @Column({ type: 'text' })
  apiKey!: string;

  @Column({ type: 'datetime' })
  verifiedAt!: Date;

  @Column({ type: 'simple-json', nullable: true })
  clusters?: Array<{ id: number; name?: string }>;
}
