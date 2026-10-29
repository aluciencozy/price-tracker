import * as React from 'react';
import { cn } from 'cn';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'min-h-11 w-full min-w-0 rounded-lg border border-control bg-card px-3 py-2 text-base file:border-0 file:bg-transparent placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-50 aria-invalid:border-destructive-foreground md:text-sm',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
