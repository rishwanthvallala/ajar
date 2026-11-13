#!/bin/bash
# Everything the 10k test made: its instances (their disks go with them) and
# its security group, found by tag and name rather than remembered.
set -euo pipefail
P=(--profile personal --region ap-south-1)
IDS=$(aws ec2 describe-instances "${P[@]}" --filters Name=tag:Purpose,Values=ajar-10k-test Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId' --output text)
if [ -n "$IDS" ]; then
  aws ec2 terminate-instances "${P[@]}" --instance-ids $IDS --query 'TerminatingInstances[].[InstanceId,CurrentState.Name]' --output text
  aws ec2 wait instance-terminated "${P[@]}" --instance-ids $IDS
fi
SG=$(aws ec2 describe-security-groups "${P[@]}" --filters Name=group-name,Values=ajar-staging --query 'SecurityGroups[0].GroupId' --output text)
[ "$SG" != None ] && aws ec2 delete-security-group "${P[@]}" --group-id "$SG" && echo "deleted $SG"
echo "left with the tag:"
aws ec2 describe-instances "${P[@]}" --filters Name=tag:Purpose,Values=ajar-10k-test Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId' --output text
aws ec2 describe-volumes "${P[@]}" --filters Name=tag:Purpose,Values=ajar-10k-test --query 'Volumes[].[VolumeId,State]' --output text
echo "(nothing above means nothing left)"
aws ec2 describe-instances "${P[@]}" --instance-ids i-0ffebdae47c7b633d --query 'Reservations[0].Instances[0].State.Name' --output text | sed 's/^/production: /'
