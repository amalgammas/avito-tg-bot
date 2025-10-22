import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'user_credentials' })
export class UserCredentialsEntity {
  @PrimaryColumn({ type: 'text' })
  chatId!: string;

  @Column({ type: 'text', nullable: true })
  clientId: string | null = null;

  @Column({ type: 'text', nullable: true })
  apiKey: string | null = null;

  @Column({ type: 'datetime', nullable: true })
  verifiedAt: Date | null = null;
}
