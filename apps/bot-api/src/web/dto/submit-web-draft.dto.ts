export class SubmitWebDraftDto {
  readyInDays!: number;
  lastDay!: string;
  timeslotFirstAvailable?: boolean;
  timeslotFromHour?: number;
  timeslotToHour?: number;
}
