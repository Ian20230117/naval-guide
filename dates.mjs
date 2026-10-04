export const timezone='Asia/Taipei';
export function dayKey(date=new Date()) {return new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(date);}
